/**
 * Simple TicTacToe for 𝙅𝙄𝙉𝙓 𝙆9
 */

const games = new Map(); // `${sessionId}:${chatId}` -> game
function key(sessionId, chatId) { return `${String(sessionId || "global")}::${String(chatId || "")}`; }

const WIN_COMBOS = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

function createGame(sessionId, chatId, playerX, playerO) {
  const k = key(sessionId, chatId);
  if (games.has(k)) return { error: 'A game is already running. Use ?tictactoe end' };

  const game = {
    board: Array(9).fill(null),
    playerX,
    playerO,
    turn: playerX,
    status: 'playing'
  };
  games.set(k, game);
  return { success: true, game };
}

function render(board) {
  const symbols = board.map((v, i) => v || String(i + 1));
  return `
${symbols[0]} | ${symbols[1]} | ${symbols[2]}
---------
${symbols[3]} | ${symbols[4]} | ${symbols[5]}
---------
${symbols[6]} | ${symbols[7]} | ${symbols[8]}
  `.trim();
}

function checkWinner(board) {
  for (const [a,b,c] of WIN_COMBOS) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  if (board.every(c => c)) return 'draw';
  return null;
}

function play(sessionId, chatId, player, position) {
  const k = key(sessionId, chatId);
  const game = games.get(k);
  if (!game) return { error: 'No active game.' };
  if (game.status !== 'playing') return { error: 'Game already finished.' };
  if (game.turn !== player) return { error: 'Not your turn.' };

  const pos = parseInt(position) - 1;
  if (isNaN(pos) || pos < 0 || pos > 8) return { error: 'Choose a number 1-9.' };
  if (game.board[pos]) return { error: 'That spot is already taken.' };

  const symbol = player === game.playerX ? '❌' : '⭕';
  game.board[pos] = symbol;

  const winner = checkWinner(game.board);
  if (winner) {
    game.status = 'ended';
    games.delete(k);
    return {
      success: true,
      board: render(game.board),
      winner: winner === 'draw' ? 'draw' : player,
      symbol
    };
  }

  game.turn = player === game.playerX ? game.playerO : game.playerX;
  return {
    success: true,
    board: render(game.board),
    next: game.turn
  };
}

function endGame(sessionId, chatId) {
  games.delete(key(sessionId, chatId));
}

function getGame(sessionId, chatId) {
  return games.get(key(sessionId, chatId));
}

module.exports = { createGame, play, endGame, getGame, render };
