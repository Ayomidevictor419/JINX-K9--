/**
 * 𝙅𝙄𝙉𝙓 𝙆9 WCG / Word Game
 * - Anyone can join by typing "join" during the join window.
 * - Players take turns in join order.
 * - Each round increases the minimum word length: 3, 4, 5, 6...
 * - Each turn gets a fresh starting letter.
 * - A player who times out is eliminated.
 * - Invalid answers do not advance the turn.
 */
const activeGames = new Map();
function key(sessionId, chatId) { return `${String(sessionId || "global")}::${String(chatId || "")}`; }
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomLetter() {
  return ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
}

function minLengthForRound(round) {
  return Math.max(3, Number(round || 1) + 2);
}

function createGame(sessionId, chatId, starterJid, mode = 'normal') {
  const k = key(sessionId, chatId);
  if (activeGames.has(k)) return { error: 'A word game is already running here. Use ?endgame first.' };
  const modes = {
    easy: { joinSeconds: 60, turnSeconds: 30 },
    normal: { joinSeconds: 45, turnSeconds: 20 },
    hard: { joinSeconds: 30, turnSeconds: 15 }
  };
  const cfg = modes[mode] || modes.normal;
  const game = {
    chatId, starter: starterJid, mode,
    players: [], status: 'waiting',
    currentIndex: 0, round: 1,
    currentLetter: null, minLength: 3,
    usedWords: new Set(),
    joinSeconds: cfg.joinSeconds, turnSeconds: cfg.turnSeconds,
    joinTimer: null, turnTimer: null, createdAt: Date.now()
  };
  activeGames.set(k, game);
  return { success: true, game };
}

function joinGame(sessionId, chatId, jid, name) {
  const game = activeGames.get(key(sessionId, chatId));
  if (!game) return { error: 'No active word game. Start one with ?wordg start.' };
  if (game.status !== 'waiting') return { error: 'The join window is closed.' };
  if (game.players.some(p => p.jid === jid)) return { error: 'You already joined the game.' };
  game.players.push({ jid, name: name || 'Player' });
  return { success: true, playersCount: game.players.length, players: game.players };
}

function clearTimers(game) {
  if (!game) return;
  if (game.joinTimer) clearTimeout(game.joinTimer);
  if (game.turnTimer) clearTimeout(game.turnTimer);
  game.joinTimer = null;
  game.turnTimer = null;
}

function startPlaying(sessionId, chatId) {
  const game = activeGames.get(key(sessionId, chatId));
  if (!game) return { error: 'No word game.' };
  if (game.status !== 'waiting') return { error: 'The game has already started.' };
  clearTimers(game);
  if (game.players.length < 2) {
    endGame(sessionId, chatId);
    return { error: 'At least 2 players are needed. Game cancelled.' };
  }
  game.status = 'playing';
  game.currentIndex = 0;
  game.round = 1;
  return nextTurn(sessionId, chatId, true);
}

function nextTurn(sessionId, chatId, sameRound = false) {
  const game = activeGames.get(key(sessionId, chatId));
  if (!game || game.status !== 'playing') return { error: 'No active word game.' };
  if (game.players.length <= 1) {
    const winner = game.players[0] || null;
    endGame(sessionId, chatId);
    return { winner };
  }
  if (game.currentIndex >= game.players.length) game.currentIndex = 0;
  if (!sameRound && game.currentIndex === 0) game.round += 1;
  game.minLength = minLengthForRound(game.round);
  game.currentLetter = randomLetter();
  return {
    success: true,
    player: game.players[game.currentIndex],
    letter: game.currentLetter,
    minLength: game.minLength,
    turnSeconds: game.turnSeconds,
    playersLeft: game.players.length,
    round: game.round
  };
}

function submitWord(sessionId, chatId, jid, word) {
  const game = activeGames.get(key(sessionId, chatId));
  if (!game || game.status !== 'playing') return { error: 'No active word game.' };
  const player = game.players[game.currentIndex];
  if (!player || player.jid !== jid) return { error: 'It is not your turn.' };

  const clean = String(word || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (clean.length < game.minLength) return { error: `❌ Word must be at least *${game.minLength} letters* long.` };
  if (!clean.startsWith(game.currentLetter)) return { error: `❌ Your word must start with *${game.currentLetter}*.` };
  if (game.usedWords.has(clean)) return { error: '❌ That word has already been used.' };

  game.usedWords.add(clean);
  if (game.turnTimer) clearTimeout(game.turnTimer);
  game.turnTimer = null;
  game.currentIndex = (game.currentIndex + 1) % game.players.length;
  const next = nextTurn(sessionId, chatId, false);
  return { success: true, word: clean, next };
}

function eliminateCurrent(sessionId, chatId) {
  const game = activeGames.get(key(sessionId, chatId));
  if (!game || game.status !== 'playing') return { error: 'No active word game.' };
  clearTimers(game);
  const removed = game.players[game.currentIndex];
  if (!removed) return { error: 'No current player.' };
  game.players.splice(game.currentIndex, 1);
  if (game.players.length <= 1) {
    const winner = game.players[0] || null;
    endGame(sessionId, chatId);
    return { removed, winner };
  }
  if (game.currentIndex >= game.players.length) game.currentIndex = 0;
  const next = nextTurn(sessionId, chatId, false);
  return { removed, next };
}

function endGame(sessionId, chatId) {
  const game = activeGames.get(key(sessionId, chatId));
  if (!game) return { success: true };
  clearTimers(game);
  activeGames.delete(key(sessionId, chatId));
  return { success: true };
}

function getGame(sessionId, chatId) {
  return activeGames.get(key(sessionId, chatId)) || null;
}

module.exports = { createGame, joinGame, startPlaying, submitWord, eliminateCurrent, endGame, getGame, nextTurn, minLengthForRound };
