const config = require('./config');
const db = require('./lib/database');
const settings = require('./lib/settings');
const wordgame = require('./lib/wordgame');
const tictactoe = require('./lib/tictactoe');
const { runtime, isUrl, getGroupAdmins, listHasId, sleep, safeCalc } = require('./lib/functions');
const axios = require('axios');
// Default timeout for every axios call in this file that doesn't set its
// own — without this, a slow/dead third-party API (weather, translate,
// image APIs, etc.) could hang for a very long time before the outer
// per-command timeout in pair.js finally kills it. 20s is generous for any
// legitimate API but still leaves headroom under that 45s ceiling.
axios.defaults.timeout = 20000;
const yts = require('yt-search');
const { downloadMp3, downloadMp3Url, downloadRemoteAudio, searchYouTube, searchYouTubeList } = require('./services/youtube');
const extras = require('./services/extras');
let chalk; try { chalk = require('chalk'); } catch { chalk = { red:s=>s, green:s=>s, yellow:s=>s, cyan:s=>s, blue:s=>s, gray:s=>s, greenBright:s=>s }; }
const { getBaileys } = require('./lib/baileys');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const sessionRuntime = require('./core/runtime');
const registry = require('./core/registry');
const sessionRegistry = require('./core/session-registry');
const doctor = require('./core/doctor');
const ai = require('./services/ai');
const chatbot = require('./services/chatbot');
const { fetchReaction, fetchReactionMedia } = require('./services/providers');
const { searchWeb } = require('./services/websearch');
const { generateImage } = require('./services/imagegen');
const { transcribe } = require('./services/transcribe');
const commandLoader = require('./core/commandLoader');
const identity = require('./lib/identity');
const { professionalize, action: responseAction } = require('./lib/responses');
require('./core/bootstrap').load();
const path = require('path');

// Group metadata cache: WhatsApp rate-limits repeated groupMetadata() calls.
// Keep a short fresh cache and allow a stale value during transient rate limits
// so admin checks do not incorrectly say "Bot must be admin".
const groupMetaCache = new Map();
// Runtime moderation state is isolated by session -> group -> user.
const slowmodeState = new Map();
const antispamState = new Map();

function runtimeKey(sessionId, groupJid, userJid) {
  return `${String(sessionId || 'global')}::${String(groupJid || '')}::${String(userJid || '')}`;
}

function pruneRuntimeMap(map, maxAgeMs) {
  const now = Date.now();
  for (const [key, value] of map) {
    const last = Array.isArray(value) ? (value[value.length - 1] || 0) : Number(value || 0);
    if (!last || now - last > maxAgeMs) map.delete(key);
  }
}
setInterval(() => {
  pruneRuntimeMap(slowmodeState, 60 * 60 * 1000);
  pruneRuntimeMap(antispamState, 2 * 60 * 60 * 1000);
}, 10 * 60 * 1000).unref?.();
const GROUP_META_TTL = 60000;
const GROUP_META_STALE_TTL = 600000;
async function getGroupMetadataCached(sock, sessionId, jid, force = false) {
  const key = `${sessionId}:${jid}`;
  const now = Date.now();
  const cached = groupMetaCache.get(key);
  if (!force && cached && (now - cached.ts) < GROUP_META_TTL) return cached.meta;
  try {
    const meta = await Promise.race([
      sock.groupMetadata(jid),
      new Promise((_, rej) => setTimeout(() => rej(new Error('group metadata timeout')), 6000))
    ]);
    if (meta?.id) {
      groupMetaCache.set(key, { meta, ts: now });
      return meta;
    }
  } catch (e) {
    const age = cached ? now - cached.ts : Infinity;
    if (cached?.meta && age < GROUP_META_STALE_TTL) return cached.meta;
    console.warn(`[${sessionId}] groupMetadata unavailable for ${jid}: ${e.message}`);
  }
  return cached?.meta || null;
}
function invalidateGroupMetadata(sessionId, jid, meta = null) {
  const key = `${sessionId}:${jid}`;
  if (meta?.id) groupMetaCache.set(key, { meta, ts: Date.now() });
  else groupMetaCache.delete(key);
}

// Temporary ignore set for bot-made promote/demote (groupJid|userJid|action)
const botActionIgnore = new Set();
function markBotAction(sessionId, groupJid, userJid, action) {
  const k = `${sessionId}|${groupJid}|${userJid}|${action}`;
  botActionIgnore.add(k);
  setTimeout(() => botActionIgnore.delete(k), 15000);
}
function isBotAction(sessionId, groupJid, userJid, action) {
  return botActionIgnore.has(`${sessionId}|${groupJid}|${userJid}|${action}`);
}


async function normalizeParticipantJid(sock, participant, participants = []) {
  return identity.normalizeParticipantJid(sock, participant, participants);
}

async function safeGroupParticipantsUpdate(sock, groupJid, participants, action, label = 'group participant update') {
  const list = [...new Set((participants || []).map(v => String(v || '').trim()).filter(Boolean))];
  if (!groupJid || !list.length) throw new Error(`${label}: no valid participant JIDs`);
  if (!['add', 'remove', 'promote', 'demote'].includes(action)) throw new Error(`${label}: invalid action ${action}`);
  try {
    return await sock.groupParticipantsUpdate(groupJid, list, action);
  } catch (error) {
    console.error(`[${groupJid}] ${label} failed (${action}):`, error?.stack || error?.message || error);
    throw error;
  }
}

function buildDeleteKey(remoteJid, ctx, fallbackKey, botJid = '') {
  const id = String(ctx?.stanzaId || '').trim();
  if (!id) return null;
  const participant = ctx?.participant || ctx?.participantAlt || undefined;
  const participantIsBot = !!participant && !!botJid && (identity.identitiesMatch(participant, botJid) || String(participant).replace(/[^0-9]/g, '') === String(botJid).replace(/[^0-9]/g, ''));
  return {
    remoteJid: String(ctx?.remoteJid || remoteJid),
    fromMe: ctx?.fromMe === true || !!participantIsBot,
    id,
    ...(participant && !participantIsBot ? { participant: String(participant) } : {})
  };
}

/** Resolve target JIDs — delegated to centralized identity module */
function getTargetJids(m, args = []) {
  return identity.getTargetJids(m, args);
}

/** Plain-text reply helpers for 𝙅𝙄𝙉𝙓 𝙆9. */
function mxBox(title, body, footer = '𝙅𝙄𝙉𝙓 𝙆9 V1') {
  return String(body || '').trim();
}
function mxOk(text) {
  return String(text || '').trim();
}
function mxWarn(text) {
  return String(text || '').trim();
}
function mxErr(text) {
  return String(text || '').trim();
}
function mxAlreadyBoxed(text) {
  const s = String(text || '');
  return s.includes('┏━━━') || s.includes('┗━━━') || s.includes('┌───') || s.includes('┏━━━━━━━━');
}
function mxAutoBox(text, title = '𝙅𝙄𝙉𝙓 𝙆9') {
  const s = String(text ?? '');
  if (!s.trim()) return s;
  if (mxAlreadyBoxed(s)) return s;
  return mxBox(title, s);
}

async function resolveElevatedTargets(sock, m, args, participants = []) {
  return identity.resolveElevatedTargets(sock, m, args, participants);
}

/** Resolve a WhatsApp JID to its real phone JID when WhatsApp provides a PN mapping. */
async function resolvePhoneJid(sock, jid, participants = []) {
  return identity.resolvePhoneJid(sock, jid, participants);
}

/** Find nested WhatsApp message keys without assuming a single wrapper layout. */
function deepHasMessageKey(value, wanted, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 7 || seen.has(value)) return false;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (wanted.has(key)) return true;
    const child = value[key];
    if (child && typeof child === 'object' && deepHasMessageKey(child, wanted, depth + 1, seen)) return true;
  }
  return false;
}

/** Send a normal WhatsApp rich link preview using Baileys' own URL preview generator. */
async function sendProfessionalText(sock, jid, text, options = {}) {
  const { mentions, quoted } = options || {};
  const out = professionalize(text, { raw: false });
  return sock.sendMessage(jid, { text: out, ...(mentions?.length ? { mentions } : {}) }, quoted ? { quoted } : undefined);
}

async function sendRichLink(sock, jid, text, quoted) {
  try {
    const { getUrlInfo } = await getBaileys();
    const match = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
    let linkPreview;
    if (match) {
      linkPreview = await getUrlInfo(match[0], {
        thumbnailWidth: 1200,
        fetchOpts: { timeout: 5000 },
        uploadImage: sock.waUploadToServer
      });
    }
    await sock.sendMessage(jid, { text, ...(linkPreview ? { linkPreview } : {}) }, quoted ? { quoted } : undefined);
    return true;
  } catch (e) {
    await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined).catch(() => {});
    return false;
  }
}


async function sendMenuVisual(sock, jid, text, quoted, sessionId) {
  const local = path.join(__dirname, 'media', 'jinx-whatsapp-menu.png');
  if (fs.existsSync(local)) {
    return await sock.sendMessage(jid, { image: fs.readFileSync(local), caption: text }, quoted ? { quoted } : undefined);
  }
  return sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
}


/**
 * Open a view-once message and send media to destJid.
 * destJid = current chat for ?vv, or owner DM for secret emoji unlock.
 * silent=true → no error replies in chat
 */
async function openViewOnce(sock, m, contextInfo, destJid, reply, { silent = false, caption } = {}) {
  try {
    const quotedMsg = contextInfo?.quotedMessage;
    if (!quotedMsg) {
      if (!silent && reply) await reply('❌ Reply to a view-once message.');
      return false;
    }

    let mediaMsg =
      quotedMsg.viewOnceMessage?.message ||
      quotedMsg.viewOnceMessageV2?.message ||
      quotedMsg.viewOnceMessageV2Extension?.message ||
      quotedMsg.ephemeralMessage?.message?.viewOnceMessage?.message ||
      quotedMsg.ephemeralMessage?.message?.viewOnceMessageV2?.message ||
      quotedMsg.ephemeralMessage?.message ||
      quotedMsg;

    // Nested wrappers
    for (let i = 0; i < 3; i++) {
      if (mediaMsg?.viewOnceMessage?.message) mediaMsg = mediaMsg.viewOnceMessage.message;
      else if (mediaMsg?.viewOnceMessageV2?.message) mediaMsg = mediaMsg.viewOnceMessageV2.message;
      else if (mediaMsg?.viewOnceMessageV2Extension?.message) mediaMsg = mediaMsg.viewOnceMessageV2Extension.message;
      else break;
    }

    const type = Object.keys(mediaMsg || {}).find((k) =>
      ['imageMessage', 'videoMessage', 'audioMessage'].includes(k)
    );
    if (!type) {
      if (!silent && reply) await reply('❌ Unsupported view-once type.');
      return false;
    }

    const { downloadContentFromMessage } = await getBaileys();
    const stream = await downloadContentFromMessage(mediaMsg[type], type.replace('Message', ''));
    const buffer = await collectMediaWithLimit(stream, 200 * 1024 * 1024, 'view-once media');

    const mime = mediaMsg[type]?.mimetype || '';
    const cap = caption !== undefined ? caption : (mediaMsg[type]?.caption || '🔓 View once opened');
    const target = destJid || m.key.remoteJid;

    if (type === 'imageMessage') {
      await sock.sendMessage(target, { image: buffer, caption: cap || undefined });
    } else if (type === 'videoMessage') {
      await sock.sendMessage(target, { video: buffer, caption: cap || undefined });
    } else if (type === 'audioMessage') {
      await sock.sendMessage(target, {
        audio: buffer,
        mimetype: mime || 'audio/ogg; codecs=opus',
        ptt: true
      });
    }
    return true;
  } catch (e) {
    console.error('openViewOnce error:', e.message);
    if (!silent && reply) await reply('❌ Failed to open view-once.');
    return false;
  }
}


async function addLoadingReact(sock, m, emoji = '⏳') {
  try {
    await sock.sendMessage(m.key.remoteJid, {
      react: { text: emoji, key: m.key }
    });
  } catch (e) {}
}

async function clearReact(sock, m) {
  try {
    await sock.sendMessage(m.key.remoteJid, {
      react: { text: '', key: m.key }
    });
  } catch (e) {}
}

async function collectMediaWithLimit(stream, maxBytes, label = 'media') {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`${label} exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB safety limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function processAudioEffect(buffer, effectName, ffmpegArgs) {
  const ffmpegPath = (() => {
    try { return require('ffmpeg-static'); } catch (e) {}
    return 'ffmpeg';
  })();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jinx-audio-'));
  const input = path.join(dir, 'input.mp3');
  const output = path.join(dir, `out-${effectName}.mp3`);
  fs.writeFileSync(input, buffer);
  await new Promise((resolve, reject) => {
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, ...ffmpegArgs, output];
    const child = require('child_process').spawn(ffmpegPath, args);
    let err = '';
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(err || `ffmpeg exited ${code}`)));
  });
  const out = fs.readFileSync(output);
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  return out;
}

async function downloadQuotedMedia(sock, m, types = ['audioMessage', 'videoMessage', 'imageMessage', 'stickerMessage', 'documentMessage']) {
  const ctx = m.message?.extendedTextMessage?.contextInfo || {};
  let quoted = ctx.quotedMessage;
  if (!quoted) return null;
  quoted =
    quoted.viewOnceMessage?.message ||
    quoted.viewOnceMessageV2?.message ||
    quoted.viewOnceMessageV2Extension?.message ||
    quoted.ephemeralMessage?.message ||
    quoted;
  const type = Object.keys(quoted || {}).find(k => types.includes(k));
  if (!type) return null;
  const { downloadContentFromMessage } = await getBaileys();
  const stream = await downloadContentFromMessage(quoted[type], type.replace('Message', ''));
  let buffer = Buffer.from([]);
  for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  return { buffer, type, msg: quoted[type], contentType: quoted[type]?.mimetype || '' };
}

const AUDIO_FX = {
  bass: ['-af', 'equalizer=f=54:width_type=o:width=2:g=20'],
  blown: ['-af', 'acrusher=.1:1:64:0:log'],
  deep: ['-af', 'atempo=4/4,asetrate=44500*2/3'],
  earrape: ['-af', 'volume=12'],
  fast: ['-filter:a', 'atempo=1.63,asetrate=44100'],
  fat: ['-filter:a', 'atempo=1.6,asetrate=22100'],
  nightcore: ['-filter:a', 'atempo=1.06,asetrate=44100*1.25'],
  reverse: ['-filter_complex', 'areverse'],
  squirrel: ['-filter:a', 'atempo=0.5,asetrate=65100'],
  robot: ['-af', "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75"],
  slow: ['-filter:a', 'atempo=0.7,asetrate=44100'],
  smooth: ['-af', 'asubboost=dry=0:wet=1:decay=0.1:feedback=0.1:cutoff=100:slope=0.5:delay=20'],
  chipmunk: ['-filter:a', 'atempo=0.8,asetrate=65100*1.3'],
  flanger: ['-af', 'flanger'],
  tremolo: ['-af', 'tremolo=f=6:d=0.5'],
  vibrato: ['-af', 'vibrato=f=7:d=0.5'],
  '8d': ['-af', 'apulsator=hz=0.125']
};


async function gifToMp4(buffer) {
  const ffmpegPath = (() => {
    try { return require('ffmpeg-static'); } catch (e) {}
    return 'ffmpeg';
  })();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jinx-gif-'));
  const input = path.join(dir, 'input.gif');
  const output = path.join(dir, 'output.mp4');
  fs.writeFileSync(input, buffer);
  await new Promise((resolve, reject) => {
    const child = require('child_process').spawn(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=15',
      '-movflags', 'faststart',
      '-pix_fmt', 'yuv420p',
      '-an',
      output
    ]);
    let err = '';
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(err || `ffmpeg exited ${code}`)));
  });
  const out = fs.readFileSync(output);
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  return out;
}

// Convert an animated (or static) webp sticker buffer to an mp4 buffer.
// ffmpeg reads webp natively so this needs no extra dependency beyond the
// ffmpeg-static binary 𝙅𝙄𝙉𝙓 𝙆9 already ships.
async function webpToMp4(buffer) {
  const ffmpegPath = (() => {
    try { return require('ffmpeg-static'); } catch (e) {}
    return 'ffmpeg';
  })();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jinx-webp-'));
  const input = path.join(tmpDir, 'input.webp');
  const output = path.join(tmpDir, 'output.mp4');
  fs.writeFileSync(input, buffer);

  const run = (args, inputBuffer = null) => new Promise((resolve, reject) => {
    const child = require('child_process').spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`)));
    if (inputBuffer) child.stdin.end(inputBuffer); else child.stdin.end();
  });

  try {
    // Fast path: FFmpeg can decode animated WebP directly on builds with the
    // WebP demuxer. This preserves animation when the input is a real animated
    // sticker.
    try {
      await run([
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', input,
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=15',
        '-movflags', 'faststart',
        '-pix_fmt', 'yuv420p',
        '-an',
        output
      ]);
      const out = fs.readFileSync(output);
      if (out.length > 1000) return out;
    } catch (directErr) {
      console.warn('webp direct decode failed, using sharp frame fallback:', directErr.message);
    }

    // Reliable fallback for animated WebP stickers: Sharp decodes all frames,
    // then FFmpeg encodes the raw RGBA frames to H.264 MP4. This also handles
    // static WebP stickers by creating a short 3-second video.
    const sharp = require('sharp');
    const meta = await sharp(buffer, { animated: true }).metadata();
    const width = Math.max(2, Math.floor(Number(meta.width || 512) / 2) * 2);
    const height = Math.max(2, Math.floor(Number(meta.pageHeight || meta.height || 512) / 2) * 2);
    const pages = Math.max(1, Number(meta.pages || 1));
    const raw = await sharp(buffer, { animated: true })
      .resize({ width, height, fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer();

    const duration = pages > 1 ? Math.max(1, Math.min(15, pages / 15)) : 3;
    await run([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pixel_format', 'rgba',
      '-video_size', `${width}x${height}`, '-framerate', '15',
      '-i', 'pipe:0',
      ...(pages === 1 ? ['-t', String(duration)] : []),
      '-movflags', 'faststart',
      '-pix_fmt', 'yuv420p',
      '-an', output
    ], raw);

    const out = fs.readFileSync(output);
    if (!out.length) throw new Error('FFmpeg produced an empty MP4');
    return out;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}


function scheduleWordTurn(sock, sessionId, groupId) {
  const game = wordgame.getGame(sessionId, groupId);
  if (!game || game.status !== 'playing') return;
  if (game.turnTimer) clearTimeout(game.turnTimer);
  game.turnTimer = setTimeout(async () => {
    try {
      const r = wordgame.eliminateCurrent(sessionId, groupId);
      if (r.winner) {
        await sock.sendMessage(groupId, {
          text: `⏰ Time up! @${r.removed.jid.split('@')[0]} eliminated.\n🏆 Winner: @${r.winner.jid.split('@')[0]}!`,
          mentions: [r.removed.jid, r.winner.jid]
        });
        return;
      }
      if (r.next?.success) {
        const p = r.next.player;
        await sock.sendMessage(groupId, {
          text:
            `⏰ @${r.removed.jid.split('@')[0]} eliminated!\n\n` +
            `🔤 Round *${r.next.round}* — minimum *${r.next.minLength} letters*\n` +
            `🎯 @${p.jid.split('@')[0]}: word starting with *${r.next.letter}*\n` +
            `⏱ ${r.next.turnSeconds}s`,
          mentions: [r.removed.jid, p.jid]
        });
        scheduleWordTurn(sock, sessionId, groupId);
      }
    } catch (e) {
      console.error('wordgame timer:', e.message);
    }
  }, (game.turnSeconds || 20) * 1000);
}

/**
 * Main message handler
 */
async function handler(sock, m, sessionId) {
  let isCmd = false;

  try {
    const msg = m.message;
    const from = m.key.remoteJid;
    const isGroup = from.endsWith('@g.us');

    // WhatsApp groups often use LID (@lid) instead of phone JID
    const senderCandidates = [
      m.key.participant,
      m.key.participantAlt,
      m.key.participantPn,
      m.participant,
      m.key.remoteJidAlt,
      !isGroup ? from : null,
      !isGroup ? m.key.remoteJid : null
    ].filter(Boolean).map(String);

    // Defense-in-depth: never let one 𝙅𝙄𝙉𝙓 𝙆9 session process another
    // 𝙅𝙄𝙉𝙓 𝙆9 session's messages, even when they share the same group.
    if (sessionRegistry.isFromOtherSession(sessionId, senderCandidates)) return;

    const sender = senderCandidates[0] || from;
    const senderNumber = String(sender).replace(/[^0-9]/g, '');
    const allSenderNums = [...new Set(
      senderCandidates.map((j) => String(j).replace(/[^0-9]/g, '')).filter((n) => n.length >= 6)
    )];

    // Extract text
    let body =
      msg.conversation ||
      msg.extendedTextMessage?.text ||
      msg.imageMessage?.caption ||
      msg.videoMessage?.caption ||
      msg.documentMessage?.caption ||
      '';

    const prefix = settings.getPrefix(sessionId) || config.DEFAULT_PREFIX || '?';

    // Sticker → command binding
    try {
      if (msg?.stickerMessage) {
        const sha = msg.stickerMessage.fileSha256;
        if (sha) {
          const hash = Buffer.isBuffer(sha) ? sha.toString('hex') : Buffer.from(sha).toString('hex');
          const map = settings.get(sessionId, 'bot', 'stickerCmds', {}) || {};
          if (map[hash]) {
            const bound = String(map[hash]).trim();
            body = bound.startsWith(prefix) ? bound : (prefix + bound);
          }
        }
      }
    } catch (e) {}

    isCmd = body.startsWith(prefix);
    const command = isCmd ? body.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase() : '';
    const args = isCmd ? body.slice(prefix.length).trim().split(/\s+/).slice(1) : [];
    const q = args.join(' ');
    const text = q;

    // Resolve sender identities only for commands. This is the single identity
    // helper used by owner/mod/sudo authorization and handles LID ↔ phone
    // mappings when WhatsApp provides a reliable mapping.
    const senderIdentities = isCmd
      ? await identity.resolveSenderIdentities(sock, senderCandidates, [])
      : [];

    // Push name
    const pushname = m.pushName || senderNumber || 'user';

    // ========== OWNERSHIP SYSTEM ==========
    const botIdFull = String(sock.user?.id || '');
    const botNumber = botIdFull.split(':')[0].replace(/[^0-9]/g, '');
    const botJid = botNumber ? botNumber + '@s.whatsapp.net' : '';
    const botLid = sock.user?.lid ? String(sock.user.lid) : '';
    const botLidNum = botLid.replace(/[^0-9]/g, '');

    // STRICT session owner: only this connected WhatsApp account can be the owner.
    // Never trust stale/global owner IDs from another deployment or another session.
    const ownIdentitySet = new Set();
    for (const value of [botIdFull, botJid, botLid, sessionId, botNumber ? botNumber + '@s.whatsapp.net' : '']) {
      if (value) ownIdentitySet.add(String(value));
    }
    const isSessionOwner =
      !!m.key.fromMe ||
      senderCandidates.some((j) => ownIdentitySet.has(String(j))) ||
      allSenderNums.some((n) => n && (n === botNumber || (botLidNum && n === botLidNum)));

    // IMPORTANT: owner/mod/sudo privileges are session-scoped. A different
    // WhatsApp account can never become owner just because old ownerIds exist.
    const isOwner = isSessionOwner;

    const elevatedHit = (fn) =>
      senderIdentities.some((j) => {
        try { return fn(sessionId, j); } catch { return false; }
      }) ||
      senderCandidates.some((j) => {
        try { return fn(sessionId, j); } catch { return false; }
      }) ||
      allSenderNums.some((n) => {
        try {
          return fn(sessionId, n + '@s.whatsapp.net') || fn(sessionId, n + '@lid');
        } catch { return false; }
      });

    const isModUser = isOwner || elevatedHit(db.isMod);
    const isPureSudo = !isOwner && !isModUser && elevatedHit(db.isSudo);
    const isSudoUser = isModUser || isPureSudo;

    // Role hierarchy: Owner > Mod > Sudo > User.
    // Mods have unrestricted command access. Sudo is intentionally limited
    // to the operational/media/group commands below; owner/mod controls stay
    // protected even when the bot is in public mode.
    const SUDO_ALLOWED_COMMANDS = new Set([
      'menu', 'ping', 'runtime', 'status', 'doctor', 'owner', 'jid', 'stats',
      'version', 's', 'toimg', 'take', 'tomp4', 'tts', 'emojimix', 'hd',
      'compress', 'vv', 'play', 'playdoc', 'ytmp3', 'ytmp4', 'ytdl', 'tiktok',
      'ig', 'fb', 'mediafire', 'gdrive', 'gitclone', 'apk', 'ytsearch', 'songinfo',
      'video', 'spotify', 'lyrics', 'ai', 'gpt', 'imagine', 'chatbot', 'aistatus',
      'search', 'translate', 'transcribe', 'slap', 'wallpaper', 'tictactoe', 'wordgame', 'quiz',
      'rps', 'startgame', 'endgame', 'antilink', 'antibadword', 'antibot', 'antitag', 'antidelete',
      'antiedit', 'forceviewonce', 'welcome', 'goodbye', 'antiforeign', 'antigroupmention', 'antigroupstatus', 'antipromote',
      'antidemote', 'antifamily', 'tagall', 'hidetag', 'kick', 'promote', 'demote', 'mute',
      'unmute', 'muteuser', 'unmuteuser', 'warn', 'resetwarn', 'warnlist', 'warns', 'warnlimit',
      'punch', 'gname', 'gdesc', 'glink', 'ginfo', 'groupinfo', 'join', 'leave',
      'linkgc', 'rules', 'groupstats', 'listadmins', 'bass', 'mp3', 'quote', 'remind',
      'weather', 'football', 'define', 'wiki', 'bible', 'style', 'calc', 'trt',
      'url', 'tinyurl', 'readmore', 'pdf', 'wm', 'ip', 'getdevice', 'audio2text',
      'temp-url', 'ngl', 'addnote', 'getnote', 'allnotes', 'delnote', 'ss', 'commands',
      'totalmessage', 'listonline',
    ]);

    const MOD_ONLY_COMMANDS = new Set([
      'sudo', 'delsudo', 'getsudo', 'mod', 'delmod', 'getmod', 'mode', 'setprefix',
      'menuimage', 'setvar', 'settheme', 'broadcast', 'block', 'unblock', 'kickall',
    ]);

    // Reply helper (safe — never hang forever)
    const reply = async (text, opts = {}) => {
      const { raw, skipBox, title, ...sendOpts } = opts || {};
      const out = professionalize(text, { raw: !!raw });
      try {
        return await sock.sendMessage(from, { text: out, ...sendOpts }, { quoted: m });
      } catch (e) {
        try {
          return await sock.sendMessage(from, { text: out });
        } catch (e2) {
          console.error('reply failed:', e2.message);
          return null;
        }
      }
    };

    // ========== WORKTYPE GATE (public / private) ==========
    // private = only owner + sudo + mod can use commands
    // public  = everyone can use normal commands (owner-only cmds still restricted)
    // DEFAULT is private. Missing DB value => private. Unauthorized = SILENT ignore.
    const worktype = String(settings.get(sessionId, 'bot', 'worktype', 'private') || 'private').toLowerCase();
    if (isCmd && worktype === 'private' && !isSudoUser) {
      console.log(`[${sessionId}] Blocked unauthorized from ${senderNumber || sender} (private mode) cmd=${command}`);
      // HARD REQUIREMENT: zero response for unauthorized users in private mode.
      // No text, no reaction, no quoted reply, no typing indicator.
      return;
    }

    // Fine-grained role gate. Owner and Mod bypass it. Pure Sudo may only
    // use the explicit allow-list; everything else returns a clear denial.
    if (isCmd && isPureSudo && !SUDO_ALLOWED_COMMANDS.has(command)) {
      const ownerOrModOnly = MOD_ONLY_COMMANDS.has(command);
      return reply(ownerOrModOnly
        ? '🔒 Mod or Owner permission is required for this command.'
        : '🔒 This command is not available to Sudo users.');
    }

    // Loading reaction disabled (was causing stuck "Waiting for this message")

    // ==================== REAL GROUP-ADMIN GATE ====================
    // Sudo is intentionally NOT treated as a WhatsApp group admin. Sudo
    // users can use the bot's normal/fun commands, but group moderation and
    // group-management commands require the sender to actually be a WhatsApp
    // group admin. Mod remains full owner-level access by design.
    // Commands that change group state, moderate members, or change group
    // protection/settings. These are NOT unlocked merely because someone is
    // a WhatsApp admin, and they are NOT unlocked merely because someone is
    // Sudo/Mod. The sender must satisfy BOTH requirements:
    //   1) explicitly elevated by this bot (Sudo/Mod), and
    //   2) currently a real WhatsApp group admin.
    // The connected session owner remains the owner override.
    const groupAdminOnlyCommands = new Set([
      'antilink', 'antibadword', 'antiforeign', 'antibot', 'antigroupmention', 'antigroup', 'antigm',
      'antimention', 'antigroupstatus', 'antigcstatus', 'antistatus',
      'antitag', 'welcome', 'setwelcome', 'setgoodbye', 'antipromote',
      'antidemote', 'forceviewonce', 'antiviewonce', 'mustvv', 'antifamily',
      'antiparent', 'muteuser', 'unmuteuser', 'unmuting', 'goodbye',
      'invite', 'linkgc', 'gclink', 'revoke', 'resetlink', 'close', 'lock',
      'open', 'unlock', 'setgcname', 'setname', 'setgcdesc', 'setdesc',
      'setgcpp', 'setpp', 'delpp', 'removepp', 'requests', 'joinrequests',
      'approveall', 'approveallrequests', 'rejectall', 'rejectallrequests',
      'approve', 'approverequest', 'reject', 'rejectrequest', 'membermode',
      'addmode', 'ephemeral', 'disappearing', 'warn', 'resetwarn', 'unwarn',
      'warnlist', 'warnlimit', 'slowmode', 'antispam', 'kick', 'kickall',
      'promote', 'demote', 'tagall', 'hidetag', 'punch', 'pin', 'pinmsg', 'unpin',
      'unpinmsg', 'mute', 'unmute', 'setrules', 'del', 'autodl', 'gfilter', 'gstop',
      'gname', 'gdesc', 'glink'
    ]);

    // Group metadata (with timeout so it cannot hang the bot)
    let groupMetadata = {};
    let participants = [];
    let groupAdmins = [];
    let isBotAdmin = false;
    let isAdmin = false;

    if (isGroup) {
      try {
        groupMetadata = await getGroupMetadataCached(sock, sessionId, from);
        participants = groupMetadata?.participants || [];
        const knownGroups = settings.get(sessionId, 'bot', 'knownGroups', {}) || {};
        knownGroups[from] = groupMetadata.subject || from;
        settings.set(sessionId, 'bot', 'knownGroups', knownGroups);
        groupAdmins = getGroupAdmins(participants);
        // Only the identities belonging to THIS socket can be the bot in the group.
        // Never use persisted owner IDs from another deployment/session here.
        isBotAdmin = listHasId(
          groupAdmins,
          botJid,
          sock.user?.id,
          sock.user?.lid,
          botNumber ? botNumber + '@s.whatsapp.net' : null,
          botNumber ? botNumber + '@lid' : null
        );
        isAdmin = listHasId(
          groupAdmins,
          sender,
          ...senderCandidates,
          ...allSenderNums.map((n) => n + '@s.whatsapp.net'),
          ...allSenderNums.map((n) => n + '@lid')
        );
      } catch (e) {
        // getGroupMetadataCached already falls back to stale metadata.
        // Keep this path quiet so WhatsApp rate-limit noise doesn't flood logs.
      }
    }

    // REAL WHATSAPP ADMIN + BOT ELEVATION GATE
    // A normal WhatsApp group admin must NOT be able to use JINX K9's
    // privileged group commands unless the bot owner has explicitly made
    // that person Sudo or Mod. Conversely, Sudo/Mod alone is not enough: they
    // must also currently be a real WhatsApp group admin.
    //
    // Required for these commands:
    //   Owner override OR (Sudo/Mod AND real WhatsApp group admin)
    //
    // This is deliberately centralized so commands such as .promote, .kick,
    // .warn, .mute, .antilink, .antipromote, .setrules, .gfilter, etc. cannot
    // accidentally fall back to an older `isAdmin || isSudo` check.
    if (isGroup && isCmd && groupAdminOnlyCommands.has(command) && !isOwner && !(isSudoUser && isAdmin)) {
      return reply('❌ You are not admin. Only admin command.');
    }

    // ==================== GROUP CHATBOT ====================
    // Opt-in per group. Default mode is mention-only; `.chatbot on` enables
    // conversational replies to normal group messages with rate limits.
    if (isGroup && !isCmd && body && !m.key?.fromMe) {
      try {
        await chatbot.maybeReply({
          sock, m, sessionId, groupJid: from, text: body, pushname,
          botJids: [botJid, botIdFull, botLid].filter(Boolean),
          botNumbers: [botNumber, botLidNum].filter(Boolean),
          isAdmin
        });
      } catch (e) { console.error('chatbot:', e.message); }
    }

    // ==================== MESSAGE / DAILY STATS (per group) ====================
    if (isGroup && sender) {
      try {
        const counts = settings.get(sessionId, from, 'msgcounts', {}) || {};
        counts[sender] = (counts[sender] || 0) + 1;
        settings.set(sessionId, from, 'msgcounts', counts);
        const displayName = pushname || senderNumber || 'WhatsApp user';
        settings.recordDailyMessage(sessionId, from, sender, displayName, isCmd);
      } catch (e) {}
    }

    // ==================== MUTED USER (delete their messages) ====================
    if (isGroup && !isAdmin && !m.key.fromMe) {
      const muted = [sender, ...senderCandidates, ...allSenderNums].some((j) =>
        j && settings.isUserMuted(sessionId, from, j)
      );
      if (muted) {
        if (isBotAdmin) {
          await sock.sendMessage(from, { delete: m.key }).catch(() => {});
        }
        return;
      }
    }

    // ==================== FORCE VIEW-ONCE (photos/videos only) ====================
    if (isGroup && settings.featureOn(sessionId, from, 'forceviewonce') && !isAdmin && !m.key.fromMe && isBotAdmin) {
      const mtype = m.mtype || Object.keys(msg || {})[0] || '';
      const isAudio = mtype === 'audioMessage' || !!msg.audioMessage;
      const isSticker = mtype === 'stickerMessage' || !!msg.stickerMessage;
      const isViewOnce =
        !!msg.viewOnceMessage ||
        !!msg.viewOnceMessageV2 ||
        !!msg.viewOnceMessageV2Extension ||
        mtype === 'viewOnceMessage' ||
        mtype === 'viewOnceMessageV2' ||
        msg.imageMessage?.viewOnce === true ||
        msg.videoMessage?.viewOnce === true;
      const isPlainImage = (mtype === 'imageMessage' || !!msg.imageMessage) && !isViewOnce;
      const isPlainVideo = (mtype === 'videoMessage' || !!msg.videoMessage) && !isViewOnce;

      if ((isPlainImage || isPlainVideo) && !isAudio && !isSticker) {
        await sock.sendMessage(from, { delete: m.key }).catch(() => {});
        const c = settings.addFeatureWarn(sessionId, from, 'forceviewonce', sender);
        const limit = settings.get(sessionId, from, 'forceviewonce_warnlimit', 3);
        await sock.sendMessage(from, {
          text: responseAction('warning', `@${senderNumber} *View-Once Media Required*\n\nPhotos and videos must be sent as *View Once*.\nVoice notes are allowed normally.\nWarning: ${c}/${limit}`),
          mentions: [sender]
        }).catch(() => {});
        if (c >= limit) {
          // mute 1 hour instead of kick
          settings.muteUser(sessionId, from, sender, 60 * 60 * 1000);
          settings.resetFeatureWarn(sessionId, from, 'forceviewonce', sender);
          await sock.sendMessage(from, {
            text: responseAction('mute', `@${senderNumber} was muted for *1 hour* after reaching the View-Once warning limit.`),
            mentions: [sender]
          }).catch(() => {});
        }
        return;
      }
    }

    // ==================== ANTI FAMILY INSULT ====================
    if (isGroup && settings.featureOn(sessionId, from, 'antifamily') && !isAdmin && !m.key.fromMe && body) {
      const lower = body.toLowerCase();
      // Common English + pidgin-style parent/family insults
      const patterns = [
        /\b(fuck|fck|f\*\*k|fuhk)\s+(your|ur|yo)\s+(dad|daddy|father|mum|mom|mother|mama|papa|sister|brother|family)/i,
        /\b(your|ur|yo)\s+(dad|daddy|father|mum|mom|mother|mama|papa|sister|bro|brother)\s+(is\s+)?(a\s+)?(fool|stupid|idiot|mumu|bastard|ashawo|whore|useless|trash)/i,
        /\b(your|ur)\s+(dad|mum|mother|father|sister)\s+(na\s+)?(mumu|fool|ashawo)/i,
        /\b(i\s+)?(fuck|fck|bang)\s+(your|ur)\s+(dad|mum|mother|father|sister|mama|papa)/i,
        /\b(una|your)\s+(papa|mama|daddy|mummy)\s+(no|is)/i,
        /\b(insult|abuse).{0,20}(parent|father|mother|sister|family)/i,
        /\b(mother\s*fucker|mofo|momofucker)\b/i,
        /\b(ya|your)\s+(mama|mamma)\b/i,
        /\b(ur|your|una)\s+(mama|mummy|mum|mom|mother|papa|daddy|dad|father)\s+(na|is|be|dey|go|don|no)\b/i,
        /\b(mama|mummy|mum|mom|mother|papa|daddy|dad|father)\s+(na|is|be|dey)\s+(mumu|fool|stupid|useless|bastard|ashawo|mad|crazy|trash)\b/i,
        /\b(fuck|fck|fuhk|bang|sleep with)\s+(ur|your|una)\s+(mama|mummy|mum|mom|mother|papa|daddy|dad|father|sister|brother)\b/i,
        /\b(ur|your|una)\s+(family|people|house)\s+(na|is|be)\s+(mad|stupid|useless|mumu|fool|bastard)\b/i
      ];
      const hit = patterns.some((re) => re.test(lower));
      if (hit) {
        if (isBotAdmin) {
          await sock.sendMessage(from, { delete: m.key }).catch(() => {});
        }
        const c = settings.addWarn(sessionId, from, sender);
        const limit = settings.get(sessionId, from, 'antifamily_warnlimit', 3);
        await sock.sendMessage(from, {
          text: responseAction('warning', `@${senderNumber} *Family Insults Are Not Allowed*\n\nWarning: ${c}/${limit}\nAfter ${limit} warnings, the user will be muted.`),
          mentions: [sender]
        }).catch(() => {});
        if (c >= limit) {
          const muteMs = settings.get(sessionId, from, 'antifamily_mutems', 60 * 60 * 1000);
          settings.muteUser(sessionId, from, sender, muteMs);
          settings.resetWarn(sessionId, from, sender);
          const mins = Math.round(muteMs / 60000);
          await sock.sendMessage(from, {
            text: responseAction('mute', `@${senderNumber} was muted for *${mins} minutes* after reaching the family-insult warning limit.\nAdmins: use ${settings.getPrefix(sessionId)}unmuteuser to remove the mute.`),
            mentions: [sender]
          }).catch(() => {});
        }
        return;
      }
    }

    // ==================== GROUP MODERATION ====================
    async function enforceAnti(feature, plainLabel) {
      const cfg = settings.getFeatureConfig(sessionId, from, feature) || {};
      const action = ['delete', 'warn', 'kick'].includes(cfg.action) ? cfg.action : 'warn';
      const maxW = Math.max(1, parseInt(cfg.maxWarnings, 10) || 3);
      await sock.sendMessage(from, { delete: m._matrixOriginalKey || m.key }).catch(() => {});
      if (feature === 'antilink') {
        const c = settings.addFeatureWarn(sessionId, from, feature, sender);
        await sock.sendMessage(from, {
          text: responseAction('warning', `*Link Blocked*\n@${senderNumber} · message removed. Warning ${c}/${maxW}.`),
          mentions: [sender]
        }).catch(() => {});
        if (c >= maxW && action === 'kick') {
          await sock.groupParticipantsUpdate(from, [sender], 'remove').catch(() => {});
          settings.resetFeatureWarn(sessionId, from, feature, sender);
          await sock.sendMessage(from, {
            text: responseAction('moderation', `@${senderNumber} reached the link warning limit and was removed.`),
            mentions: [sender]
          }).catch(() => {});
        }
        return true;
      }
      if (action === 'delete') {
        await sock.sendMessage(from, {
          text: responseAction('moderation', `*${plainLabel} Blocked*\n@${senderNumber} · message removed.`),
          mentions: [sender]
        }).catch(() => {});
        return true;
      }
      if (action === 'kick') {
        await sock.groupParticipantsUpdate(from, [sender], 'remove').catch(() => {});
        await sock.sendMessage(from, {
          text: responseAction('moderation', `*${plainLabel} Violation*\n@${senderNumber} was removed from the group.`),
          mentions: [sender]
        }).catch(() => {});
        return true;
      }
      const c = settings.addFeatureWarn(sessionId, from, feature, sender);
      const left = Math.max(0, maxW - c);
      await sock.sendMessage(from, {
        text: responseAction('warning', `*${plainLabel} Restricted*\n@${senderNumber} · warning ${c}/${maxW} · ${left} remaining before removal.`),
        mentions: [sender]
      }).catch(() => {});
      if (c >= maxW) {
        await sock.groupParticipantsUpdate(from, [sender], 'remove').catch(() => {});
        settings.resetFeatureWarn(sessionId, from, feature, sender);
        await sock.sendMessage(from, {
          text: responseAction('moderation', `@${senderNumber} reached the ${plainLabel.toLowerCase()} warning limit and was removed.`),
          mentions: [sender]
        }).catch(() => {});
      }
      return true;
    }

    if (isGroup && !isAdmin && isBotAdmin && !m.key.fromMe) {
      // Anti-Foreign: Nigeria-first country-code filter (234). Admins are exempt.
      if (settings.featureOn(sessionId, from, 'antiforeign')) {
        const n = String(senderNumber || '').replace(/\D/g, '');
        if (n && !n.startsWith('234')) {
          await sock.sendMessage(from, { delete: m.key }).catch(() => {});
          await sock.sendMessage(from, { text: responseAction('moderation', `@${senderNumber} was removed by Anti-Foreign.`), mentions: [sender] }).catch(() => {});
          await sock.groupParticipantsUpdate(from, [sender], 'remove').catch(() => {});
          return;
        }
      }

      // Anti-Link
      if (settings.featureOn(sessionId, from, 'antilink') && isUrl(body) && !isAdmin && isBotAdmin) {
        const linkCfg = settings.getFeatureConfig(sessionId, from, 'antilink') || {};
        const allowed = Array.isArray(linkCfg.permitted) ? linkCfg.permitted : [];
        const bodyLower = String(body || '').toLowerCase();
        const isAllowed = allowed.some(u => u && bodyLower.includes(String(u).toLowerCase()));
        if (!isAllowed) {
          settings.recordDailyEvent(sessionId, from, 'linkBlocks', 1);
          await enforceAnti('antilink', 'Links');
          return;
        }
      }

      // Anti-Word (group word filter)
      if (settings.featureOn(sessionId, from, 'antiword') && body) {
        const wcfg = settings.getFeatureConfig(sessionId, from, 'antiword') || {};
        const words = Array.isArray(wcfg.words) ? wcfg.words : [];
        const lower = String(body).toLowerCase();
        const hit = words.find(w => w && lower.includes(String(w).toLowerCase()));
        if (hit) {
          await enforceAnti('antiword', `Forbidden word (${hit})`);
          return;
        }
      }

      // Anti-Bot
      if (settings.featureOn(sessionId, from, 'antibot')) {
        const msgId = String(m.key?.id || '');
        const antiBotSignal = Boolean(
          msgId.startsWith('BAE5') ||
          msgId.startsWith('3EB0') ||
          !!msg.botInvokeMessage ||
          !!msg.botTaskMessage ||
          !!msg.botForwardedMessage ||
          m.isBaileys === true
        );
        if (antiBotSignal) {
          await enforceAnti('antibot', 'Bot messages');
          return;
        }
      }

      // Anti-Tag
      if (settings.featureOn(sessionId, from, 'antitag')) {
        const mentioned = msg?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (mentioned.length >= 5) {
          await enforceAnti('antitag', 'Mass tags');
          return;
        }
      }

      // Detect message type key (top-level + nested)
      const mtype = Object.keys(msg || {})[0] || '';
      const nestedMsg =
        msg?.viewOnceMessageV2?.message ||
        msg?.viewOnceMessage?.message ||
        msg?.ephemeralMessage?.message ||
        msg?.documentWithCaptionMessage?.message ||
        null;
      const nestedType = nestedMsg ? Object.keys(nestedMsg)[0] : '';

      // ---------- Anti-Group Mention ----------
      // ONLY when someone mentions THIS GROUP in their status.
      // Ordinary chat messages and normal @tags are NEVER touched.
      if (settings.featureOn(sessionId, from, 'antigroupmention')) {
        const isGroupStatusMention = deepHasMessageKey(
          msg,
          new Set(['groupStatusMentionMessage', 'groupMentionedMessage', 'statusMentionMessage'])
        );

        if (isGroupStatusMention) {
          console.log(`[antigroupmention] HIT in ${from} mtype=${mtype} nested=${nestedType}`);
          await enforceAnti('antigroupmention', 'Group status mentions');
          return;
        }
      }

      // ---------- Anti-Group Status ----------
      // When someone posts a Group Status inside the group.
      if (settings.featureOn(sessionId, from, 'antigroupstatus')) {
        const isGroupStatusPost = deepHasMessageKey(
          msg,
          new Set(['groupStatusMessageV2', 'groupStatusMessage'])
        );

        const keys = Object.keys(msg || {});

        if (isGroupStatusPost) {
          console.log(`[antigroupstatus] HIT in ${from} mtype=${mtype} nested=${nestedType} keys=${keys.join(',')}`);
          await enforceAnti('antigroupstatus', 'Group status');
          return;
        }
      }
    }

    // ==================== VIEW-ONCE EMOJI UNLOCK (secret → owner DM) ====================
    // Reply to a view-once with ANY emoji/sticker → media goes to YOUR private chat with the bot
    // No message is sent in the group (secret).
    try {
      const bodyTrim = (body || '').trim();
      const isStickerReply = !!msg?.stickerMessage;
      const emojiOnly =
        isStickerReply ||
        (bodyTrim.length > 0 &&
          bodyTrim.length <= 8 &&
          /^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D])+$/u.test(
            bodyTrim
          ));

      const contextInfo =
        msg?.extendedTextMessage?.contextInfo ||
        msg?.imageMessage?.contextInfo ||
        msg?.videoMessage?.contextInfo ||
        msg?.stickerMessage?.contextInfo ||
        msg?.reactionMessage?.contextInfo ||
        {};

      const quotedMsg = contextInfo.quotedMessage || null;

      const isQuotedViewOnce = !!(
        quotedMsg &&
        (
          quotedMsg.viewOnceMessage ||
          quotedMsg.viewOnceMessageV2 ||
          quotedMsg.viewOnceMessageV2Extension ||
          quotedMsg.ephemeralMessage?.message?.viewOnceMessage ||
          quotedMsg.ephemeralMessage?.message?.viewOnceMessageV2 ||
          quotedMsg.imageMessage?.viewOnce === true ||
          quotedMsg.videoMessage?.viewOnce === true ||
          quotedMsg.audioMessage?.viewOnce === true ||
          // Some WA versions only set viewOnce on the media node
          Object.values(quotedMsg).some(
            (v) => v && typeof v === 'object' && (v.viewOnce === true || v.viewOnce === 1)
          )
        )
      );

      if (emojiOnly && isQuotedViewOnce && (isOwner || isSudoUser || isSessionOwner)) {
        const ownerJid = botJid || (botNumber ? botNumber + '@s.whatsapp.net' : null);
        if (ownerJid) {
          const ok = await openViewOnce(sock, m, contextInfo, ownerJid, null, {
            silent: true,
            caption: ''
          });
          if (ok) {
            console.log(`[${sessionId}] Secret VV unlocked → ${ownerJid}`);
          } else {
            console.log(`[${sessionId}] Secret VV unlock failed (download)`);
          }
        }
        return; // never reveal in group
      }
    } catch (e) {
      console.error('emoji vv error:', e.message);
    }


    // ==================== AUTO FILTERS ====================
    if (!isCmd && body) {
      try {
        if (!isGroup) {
          const filters = settings.get(sessionId, 'bot', 'pfilters', {}) || {};
          const key = body.trim().toLowerCase();
          if (filters[key]) {
            await sock.sendMessage(from, { text: filters[key] }, { quoted: m });
            return;
          }
        } else {
          const filters = settings.get(sessionId, from, 'gfilters', {}) || {};
          const key = body.trim().toLowerCase();
          if (filters[key] && isSudoUser) {
            // only respond for authorized in private bot mode groups? allow for all if filter set by admin
          }
          if (filters[key]) {
            await sock.sendMessage(from, { text: filters[key] }, { quoted: m });
            return;
          }
        }
      } catch (e) {}
    }


    // ==================== SLOWMODE + ANTISPAM ====================
    if (isGroup && !isAdmin && !m.key.fromMe) {
      try {
        // Slowmode
        if (settings.get(sessionId, from, 'slowmode', false)) {
          const sec = Number(settings.get(sessionId, from, 'slowmode_sec', 10)) || 10;
          const key = runtimeKey(sessionId, from, sender);
          const last = slowmodeState.get(key) || 0;
          const now = Date.now();
          if (now - last < sec * 1000) {
            try { await sock.sendMessage(from, { delete: m.key }); } catch (e) {}
            return;
          }
          slowmodeState.set(key, now);
        }
        // Antispam
        if (settings.get(sessionId, from, 'antispam', false)) {
          const maxC = Number(settings.get(sessionId, from, 'antispam_count', 5)) || 5;
          const win = Number(settings.get(sessionId, from, 'antispam_window', 10)) || 10;
          const action = settings.get(sessionId, from, 'antispam_action', 'warn') || 'warn';
          const key = runtimeKey(sessionId, from, sender);
          const now = Date.now();
          let arr = antispamState.get(key) || [];
          arr = arr.filter((t) => now - t < win * 1000);
          arr.push(now);
          antispamState.set(key, arr);
          if (arr.length >= maxC) {
            antispamState.delete(key);
            try { await sock.sendMessage(from, { delete: m.key }); } catch (e) {}
            if (action === 'kick' && isBotAdmin) {
              await sock.groupParticipantsUpdate(from, [sender], 'remove').catch(() => {});
              await sendProfessionalText(sock, from, `@${sender.split('@')[0]} was removed for repeated spam.`, { mentions: [sender] });
            } else if (action === 'warn') {
              const c = settings.addWarn(sessionId, from, sender);
              const limit = settings.get(sessionId, from, 'warnlimit', 3);
              await sendProfessionalText(sock, from, `@${sender.split('@')[0]} · spam detected · warning ${c}/${limit}.`, { mentions: [sender] });
              if (c >= limit && isBotAdmin) {
                await sock.groupParticipantsUpdate(from, [sender], 'remove').catch(() => {});
                settings.resetWarn(sessionId, from, sender);
              }
            } else {
              await sendProfessionalText(sock, from, `@${sender.split('@')[0]} · spam message removed.`, { mentions: [sender] });
            }
            return;
          }
        }
      } catch (e) {}
    }

    // ==================== WORD GAME / WCG ====================
    if (!isCmd && isGroup && body.trim().toLowerCase() === 'join') {
      const game = wordgame.getGame(sessionId, from);
      if (!game || game.status !== 'waiting') return;
      const res = wordgame.joinGame(sessionId, from, sender, pushname);
      if (res.error) return reply(res.error);
      settings.recordDailyEvent(sessionId, from, 'games', 0);
      await reply(`✅ @${senderNumber || 'user'} joined the word game! (*${res.playersCount} players*)`, { mentions: [sender] });
      return;
    }

    if (!isCmd && isGroup && body && wordgame.getGame(sessionId, from)?.status === 'playing') {
      const game = wordgame.getGame(sessionId, from);
      const current = game?.players?.[game.currentIndex];
      if (current?.jid === sender) {
        const res = wordgame.submitWord(sessionId, from, sender, body);
        if (res.error) return reply(res.error);
        if (res.next?.winner) {
          await reply(
            `🏆 *Winner:* @${res.next.winner.jid.split('@')[0]}!\n` +
            `Accepted word: *${res.word}*`,
            { mentions: [res.next.winner.jid] }
          );
          return;
        }
        if (res.next?.success) {
          const p = res.next.player;
          await reply(
            `✅ *${res.word}* accepted!\n\n` +
            `🔤 Round *${res.next.round}* — minimum *${res.next.minLength} letters*\n` +
            `🎯 @${p.jid.split('@')[0]}: word starting with *${res.next.letter}*\n` +
            `⏱ ${res.next.turnSeconds}s`,
            { mentions: [p.jid] }
          );
          scheduleWordTurn(sock, sessionId, from);
        }
        return;
      }
    }

    // TicTacToe moves (1-9)
    if (!isCmd && isGroup) {
      const tttGame = tictactoe.getGame(sessionId, from);
      if (tttGame && tttGame.status === 'playing' && /^[1-9]$/.test(body.trim())) {
        const res = tictactoe.play(sessionId, from, sender, body.trim());
        if (res.error) return reply(res.error);
        if (res.winner) {
          if (res.winner === 'draw') return reply(`${res.board}\n\n🤝 It's a draw!`);
          return sock.sendMessage(from, {
            text: `${res.board}\n\n🏆 @${res.winner.split('@')[0]} wins!`,
            mentions: [res.winner]
          });
        }
        return sock.sendMessage(from, {
          text: `${res.board}\n\nTurn: @${res.next.split('@')[0]}`,
          mentions: [res.next]
        });
      }
    }


    // ==================== AFK SYSTEM (per group) ====================
    if (isGroup && body) {
      try {
        const afkMap = settings.get(sessionId, from, 'afk', {}) || {};
        // If sender was AFK and now talks -> welcome back
        if (afkMap[sender]) {
          const reason = afkMap[sender].reason || 'AFK';
          delete afkMap[sender];
          settings.set(sessionId, from, 'afk', afkMap);
          await sock.sendMessage(from, {
            text: `✅ Welcome back @${senderNumber}!\nYou were AFK: ${reason}`,
            mentions: [sender]
          }).catch(() => {});
        }
        // If someone mentions an AFK user
        const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        for (const jid of mentioned) {
          if (afkMap[jid]) {
            const info = afkMap[jid];
            const mins = Math.max(1, Math.round((Date.now() - (info.since || Date.now())) / 60000));
            await sock.sendMessage(from, {
              text: `💤 @${jid.split('@')[0]} is *AFK*\nReason: ${info.reason || '-'}\nSince: ${mins} min ago`,
              mentions: [jid]
            }).catch(() => {});
          }
        }
      } catch (e) {}
    }


    // ==================== AUTODL (auto-download media links) ====================
    if (!isCmd && body && /https?:\/\//i.test(body)) {
      try {
        const autodlOn = settings.get(sessionId, isGroup ? from : 'bot', 'autodl', settings.get(sessionId, 'bot', 'autodl', false));
        if (autodlOn && (isOwner || isModUser || isSudoUser || !isGroup || isAdmin || settings.get(sessionId, 'bot', 'worktype', 'private') === 'public')) {
          const urlMatch = String(body).match(/https?:\/\/[^\s<>"']+/i);
          const url = urlMatch ? urlMatch[0].replace(/[)\]>,.]+$/, '') : null;
          if (url) {
            const lower = url.toLowerCase();
            // Reuse existing downloader logic lightly via synthetic command path
            if (/youtube\.com|youtu\.be/.test(lower)) {
              // queue as play for audio shorts/links
              try {
                const { downloadMp3Url, downloadRemoteAudio, downloadMp3 } = require('./services/youtube');
                let vidUrl = url;
                if (!/watch\?v=|youtu\.be\//.test(url)) {
                  // leave as-is
                }
                await sendProfessionalText(sock, from, 'Downloading YouTube audio…').catch(() => {});
                try {
                  const remote = await downloadMp3Url(vidUrl);
                  try {
                    await sock.sendMessage(from, { audio: { url: remote.url }, mimetype: 'audio/mpeg', ptt: false }, { quoted: m });
                  } catch {
                    const buf = await downloadRemoteAudio(remote.url);
                    await sock.sendMessage(from, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, { quoted: m });
                  }
                } catch (e1) {
                  try {
                    const { buffer } = await downloadMp3(vidUrl);
                    await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mpeg', ptt: false }, { quoted: m });
                  } catch (e2) {
                    console.error('autodl yt failed:', e2.message);
                  }
                }
                return;
              } catch (e) { console.error('autodl yt:', e.message); }
            } else if (/tiktok\.com|vt\.tiktok/.test(lower)) {
              // hand off by setting body to command-like - call tiktok APIs similar to case
              try {
                const axios = require('axios');
                await sendProfessionalText(sock, from, 'Downloading TikTok media…').catch(() => {});
                const res = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`, { timeout: 30000 });
                const d = res.data?.data;
                if (d?.play) {
                  await sock.sendMessage(from, { video: { url: d.play }, caption: d.title || 'TikTok' }, { quoted: m });
                  return;
                }
              } catch (e) { console.error('autodl tt:', e.message); }
            } else if (/instagram\.com|instagr\.am/.test(lower)) {
              try {
                const axios = require('axios');
                await sendProfessionalText(sock, from, 'Downloading Instagram media…').catch(() => {});
                const apis = [
                  `https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(url)}`,
                  `https://apis.davidcyriltech.my.id/instagram?url=${encodeURIComponent(url)}`
                ];
                for (const api of apis) {
                  try {
                    const { data } = await axios.get(api, { timeout: 45000 });
                    const media = data?.result?.[0]?.url || data?.data?.[0]?.url || data?.result?.url || data?.url;
                    if (media) {
                      const isVid = /\.mp4|video/i.test(media);
                      if (isVid) await sock.sendMessage(from, { video: { url: media }, caption: 'Instagram' }, { quoted: m });
                      else await sock.sendMessage(from, { image: { url: media }, caption: 'Instagram' }, { quoted: m });
                      return;
                    }
                  } catch (_) {}
                }
              } catch (e) { console.error('autodl ig:', e.message); }
            }
          }
        }
      } catch (e) { console.error('autodl:', e.message); }
    }

    if (!isCmd) return;

    const commandStartedAt = process.hrtime.bigint();
    const registeredCommand = registry.get(command);
    if (!registeredCommand) return;
    console.log(chalk.blue(`[${sessionId}] ${pushname}: ${prefix}${command} ${q}`));

    // One centralized command reaction for every authorized command.
    // Authorization has already completed above, so unauthorized private-mode
    // users never receive a reaction. The exact session socket is always used.
    await addLoadingReact(sock, m, '🌀');

    try {
      // ==================== ONE AUTHORITATIVE COMMAND REGISTRY ====================
      if (registeredCommand.source === 'modern') {
        const cmd = commandLoader.getCommand(command);
        if (!cmd || typeof cmd.run !== 'function') throw new Error(`Registered command implementation missing: ${command}`);
        await cmd.run({
          sock, m, args, text: q, prefix, reply, from, sender, isGroup, isAdmin,
          isBotAdmin, participants, groupAdmins, isOwner, isModUser, isSudoUser,
          isPureSudo, sessionId, pushname, command, commandStartedAt
        });
        return;
      }

      // ==================== LEGACY IMPLEMENTATIONS (ONE REGISTRATION EACH) ====================
      switch (command) {

      case 'status': {
        const mem = process.memoryUsage();
        const rss = (mem.rss / 1024 / 1024).toFixed(1);
        const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
        const total = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
        const commandCount = registry.all().length;
        const runtime = sessionRuntime.display(sessionId);
        const sessionLabel = String(sessionId || 'default');
        await reply(
          `🖥️ *𝙅𝙄𝙉𝙓 𝙆9 STATUS*\n\n` +
          `🟢 Connection: *Online*\n` +
          `🆔 Session: *${sessionLabel}*\n` +
          `⏱️ Uptime: *${runtime}*\n` +
          `📦 Commands: *${commandCount}*\n` +
          `🟦 Node: *${process.version}*\n` +
          `💾 RAM: *${rss} MB RSS / ${heap} MB heap*\n` +
          `🖥️ Platform: *${os.platform()} ${os.arch()}*\n` +
          `🧠 Host RAM: *${total} GB*`
        );
        break;
      }

      case 'runtime': {
        await reply(
          `╔══ *𝙅𝙄𝙉𝙓 𝙆9 UPTIME* ══╗\n\n` +
          `🕒 Runtime: *${sessionRuntime.display(sessionId)}*\n` +
          `⚡ Status: *Online*\n` +
          `🤖 Bot: *𝙅𝙄𝙉𝙓 𝙆9*\n\n` +
          `╚════════════════╝`
        );
        break;
      }

      case 'doctor': {
        await reply(doctor.text(doctor.check(sessionId, sock)));
        break;
      }

      case 'owner': {
        const owners = config.OWNER_NUMBERS.map(n => `https://wa.me/${n}`).join('\n');
        const ownerText =
          `👑 *${config.BOT_NAME}*\n\n` +
          `*Developer:* ${config.OWNER_NAME}\n` +
          `Telegram: ${config.OWNER_TELEGRAM}\n\n` +
          `*Contact WhatsApp:*\n${owners}\n\n` +
          `_Tap a link to message the owner._`;
        await sendRichLink(sock, from, ownerText, m);
        break;
      }

      case 'jid': {
        await reply(`Chat JID: ${from}\nYour JID: ${sender}`);
        break;
      }

      // ---------- PREFIX ----------
      case 'setprefix': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        if (!args[0] || args[0].length > 3) return reply(`Example: ${prefix}setprefix ?`);
        settings.setPrefix(sessionId, args[0]);
        await reply(`Prefix is now ${args[0]}.`);
        break;
      }

      case 'settheme': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const allowed = ['prime','cyber','minimal'];
        const theme = String(args[0] || '').toLowerCase();
        if (!allowed.includes(theme)) return reply(`Usage: ${prefix}settheme ${allowed.join('|')}`);
        settings.set(sessionId, 'bot', 'theme', theme);
        await reply(`Theme is now ${theme}.`);
        break;
      }

      case 'theme': {
        await reply(`🎨 Theme: *${settings.get(sessionId, 'bot', 'theme', 'prime')}*`);
        break;
      }

      case 'commands': {
        const cats = registry.categories();
        const lines = Object.entries(cats).map(([cat, list]) => `*${cat}* — ${list.length}`);
        await reply(`📦 *𝙅𝙄𝙉𝙓 𝙆9 Commands*\n\n${lines.join('\n')}\n\nTotal registered: *${registry.all().length}*`);
        break;
      }

      case 'version': {
        await reply(`⚡ *${config.BOT_NAME} V${config.VERSION}*\nBaileys: v7\nNode: ${process.version}`);
        break;
      }

      // ---------- GROUP FEATURES ----------
      case 'antilink': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo can use this.');
        const opt = (args[0] || '').toLowerCase();
        const rest = args.slice(1).join(' ').trim();
        const maxW = Math.max(1, parseInt(args[1], 10) || 3);
        const cfg = settings.getFeatureConfig(sessionId, from, 'antilink') || {};
        const permitted = Array.isArray(cfg.permitted) ? cfg.permitted : [];

        if (!opt) {
          return reply(
            `*LINK SHIELD*\n` +
            `Usage:\n` +
            `${prefix}antilink on|warn|delete|kick|off\n` +
            `${prefix}antilink warn 4\n` +
            `${prefix}antilink allow youtube.com\n` +
            `${prefix}antilink unallow youtube.com\n` +
            `${prefix}antilink listallow\n` +
            `${prefix}antilink status`
          );
        }
        if (opt === 'off') {
          if (!settings.featureOn(sessionId, from, 'antilink')) return reply(mxOk('Link shield already *OFF*.'));
          settings.setFeature(sessionId, from, 'antilink', false);
          return reply(mxBox('LINK SHIELD', 'Status: *OFF*\nLinks are unrestricted in this group.'));
        }
        if (opt === 'status') {
          const on = settings.featureOn(sessionId, from, 'antilink');
          return reply(mxBox('LINK SHIELD',
            `Status: *${on ? 'ON' : 'OFF'}*\n` +
            `Action: *${cfg.action || '-'}*\n` +
            `Max warns: *${cfg.maxWarnings || 3}*\n` +
            `Allow-list: *${permitted.length}* domain(s)`
          ));
        }
        if (opt === 'allow') {
          if (!rest) return reply(`Example: ${prefix}antilink allow youtube.com`);
          if (permitted.includes(rest)) return reply(`Already allowed: ${rest}`);
          permitted.push(rest);
          settings.setFeatureConfig(sessionId, from, 'antilink', { ...cfg, permitted });
          settings.setFeature(sessionId, from, 'antilink', true);
          return reply(`✅ Allowed URL: ${rest}`);
        }
        if (opt === 'unallow') {
          if (!rest) return reply(`Example: ${prefix}antilink unallow youtube.com`);
          const idx = permitted.indexOf(rest);
          if (idx < 0) return reply(`Not in allow list: ${rest}`);
          permitted.splice(idx, 1);
          settings.setFeatureConfig(sessionId, from, 'antilink', { ...cfg, permitted });
          return reply(`✅ Removed allowed URL: ${rest}`);
        }
        if (opt === 'listallow') {
          if (!permitted.length) return reply('No allowed URLs.');
          return reply('*Allowed URLs*\n' + permitted.map((u, i) => `${i + 1}. ${u}`).join('\n'));
        }
        if (!['on','warn','delete','kick'].includes(opt)) {
          return reply(`Usage: ${prefix}antilink on|warn|delete|kick|off|allow|unallow|listallow|status`);
        }
        const action = opt === 'on' ? 'warn' : opt;
        if (settings.featureOn(sessionId, from, 'antilink') && cfg.action === action && Number(cfg.maxWarnings || 3) === maxW) {
          return reply(mxOk('Link shield already active with those settings.'));
        }
        settings.setFeature(sessionId, from, 'antilink', true);
        settings.setFeatureConfig(sessionId, from, 'antilink', {
          action,
          maxWarnings: maxW,
          permitted
        });
        await reply(mxBox('LINK SHIELD', `Status: *ON*\nAction: *${action}*${action === 'warn' ? `\nMax warnings: *${maxW}*` : ''}\nOutside allow-list → enforced.`));
        break;
      }

      case 'antibot': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo can use this.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const opt = (args[0] || '').toLowerCase();
        const maxW = Math.max(1, parseInt(args[1], 10) || 3);
        if (opt === 'off') {
          if (!settings.featureOn(sessionId, from, 'antibot')) return reply('Anti-Bot is already OFF.');
          settings.setFeature(sessionId, from, 'antibot', false);
          return reply('🤖 Bot shield disabled.');
        }
        if (opt === 'status') return reply(`Anti-Bot is ${settings.featureOn(sessionId, from, 'antibot') ? 'ON' : 'OFF'}.`);
        if (!['on','delete','warn','kick'].includes(opt)) return reply(`Usage: ${prefix}antibot on|delete|warn|kick|off`);
        const action = opt === 'on' ? 'warn' : opt;
        settings.setFeature(sessionId, from, 'antibot', true);
        settings.setFeatureConfig(sessionId, from, 'antibot', { action, maxWarnings: maxW });
        await reply('🤖 Bot shield *active* — bot-like messages will be handled.');
        break;
      }

      case 'antigroupmention': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const opt = (args[0] || '').toLowerCase();
        const maxW = Math.max(1, parseInt(args[1], 10) || 3);
        if (opt === 'off') {
          if (!settings.featureOn(sessionId, from, 'antigroupmention')) return reply('Anti-Group Mention is already OFF.');
          settings.setFeature(sessionId, from, 'antigroupmention', false);
          return reply('Anti-Group Mention is OFF.');
        }
        if (opt === 'status') return reply(`Anti-Group Mention is ${settings.featureOn(sessionId, from, 'antigroupmention') ? 'ON' : 'OFF'}.`);
        if (!['on','delete','warn','kick'].includes(opt)) return reply(`Usage: ${prefix}antigm on|delete|warn|kick|off`);
        const action = opt === 'on' ? 'warn' : opt;
        settings.setFeature(sessionId, from, 'antigroupmention', true);
        settings.setFeatureConfig(sessionId, from, 'antigroupmention', { action, maxWarnings: maxW });
        await reply('Anti-Group Mention is ON.');
        break;
      }

      case 'antigroupstatus': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const opt = (args[0] || '').toLowerCase();
        const maxW = Math.max(1, parseInt(args[1], 10) || 3);
        if (opt === 'off') {
          if (!settings.featureOn(sessionId, from, 'antigroupstatus')) return reply('Anti-Group Status is already OFF.');
          settings.setFeature(sessionId, from, 'antigroupstatus', false);
          return reply('Anti-Group Status is OFF.');
        }
        if (opt === 'status') return reply(`Anti-Group Status is ${settings.featureOn(sessionId, from, 'antigroupstatus') ? 'ON' : 'OFF'}.`);
        if (!['on','delete','warn','kick'].includes(opt)) return reply(`Usage: ${prefix}antistatus on|delete|warn|kick|off`);
        const action = opt === 'on' ? 'warn' : opt;
        settings.setFeature(sessionId, from, 'antigroupstatus', true);
        settings.setFeatureConfig(sessionId, from, 'antigroupstatus', { action, maxWarnings: maxW });
        await reply('Anti-Group Status is ON.');
        break;
      }

      case 'antitag': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          if (settings.featureOn(sessionId, from, 'antitag')) return reply('Anti-Tag is already ON.');
          settings.setFeature(sessionId, from, 'antitag', true);
          return reply('🏷️ Mass-tag shield *active*.');
        }
        if (opt === 'off') {
          if (!settings.featureOn(sessionId, from, 'antitag')) return reply('Anti-Tag is already OFF.');
          settings.setFeature(sessionId, from, 'antitag', false);
          return reply('🏷️ Mass-tag shield disabled.');
        }
        await reply(`Usage: ${prefix}antitag on|off`);
        break;
      }

      case 'welcome': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          if (settings.featureOn(sessionId, from, 'welcome')) return reply('Welcome is already ON.');
          settings.setFeature(sessionId, from, 'welcome', true);
          const def =
            '👋 Welcome @user to *@group*\n\n' +
            '📌 Please introduce yourself:\n' +
            '• Name:\n• Age:\n• Location:\n• Hobbies:\n\n' +
            'Photos/videos as *View Once* only.\nThank you for joining!';
          if (!settings.get(sessionId, from, 'welcometext', null)) {
            settings.setWelcomeText(sessionId, from, def);
          }
          await reply('✅ Welcome ON\nDefault message set. Use ' + prefix + 'setwelcome to customize.\nPlaceholders: @user @group @pp @time @date @desc @members');
        } else if (opt === 'off') {
          if (!settings.featureOn(sessionId, from, 'welcome')) return reply('Welcome is already OFF.');
          settings.setFeature(sessionId, from, 'welcome', false);
          await reply('👋 Welcome messages turned *off*.');
        } else {
          await reply(`Usage: ${prefix}welcome on/off`);
        }
        break;
      }

      case 'setwelcome': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        if (!q) {
          return reply(
            `*Set Welcome Message*\n\n` +
            `Example:\n${prefix}setwelcome Welcome @user to @group!\n\n` +
            `*Placeholders:*\n` +
            `@user — tag the new member\n` +
            `@pp — send their profile picture\n` +
            `@time — current time\n` +
            `@date — current date\n` +
            `@group — group name\n` +
            `@desc — group description\n` +
            `@members — member count\n` +
            `@bot — bot name`
          );
        }
        settings.setWelcomeText(sessionId, from, q);
        await reply('✅ Welcome text updated.\nUse: ' + prefix + 'welcome on');
        break;
      }

      case 'setgoodbye': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        if (!q) {
          return reply(
            `Example: ${prefix}setgoodbye Goodbye @user\n\n` +
            `Placeholders: @user @time @date @group @desc @members @bot`
          );
        }
        settings.setGoodbyeText(sessionId, from, q);
        await reply('✅ Goodbye text updated.\nUse: ' + prefix + 'goodbye on');
        break;
      }

      case 'antipromote': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          if (settings.featureOn(sessionId, from, 'antipromote')) return reply('Anti-Promote is already ON.');
          settings.setFeature(sessionId, from, 'antipromote', true);
          await reply('Anti-Promote is ON.');
        } else if (opt === 'off') {
          if (!settings.featureOn(sessionId, from, 'antipromote')) return reply('Anti-Promote is already OFF.');
          settings.setFeature(sessionId, from, 'antipromote', false);
          await reply('Anti-Promote is OFF.');
        } else {
          await reply(`Usage: ${prefix}antipromote\nCurrent: ${settings.featureOn(sessionId, from, 'antipromote')?'ON':'OFF'}`);
        }
        break;
      }

      case 'antidemote': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          if (settings.featureOn(sessionId, from, 'antidemote')) return reply('Anti-Demote is already ON.');
          settings.setFeature(sessionId, from, 'antidemote', true);
          await reply('Anti-Demote is ON.');
        } else if (opt === 'off') {
          if (!settings.featureOn(sessionId, from, 'antidemote')) return reply('Anti-Demote is already OFF.');
          settings.setFeature(sessionId, from, 'antidemote', false);
          await reply('Anti-Demote is OFF.');
        } else {
          await reply(`Usage: ${prefix}antidemote\nCurrent: ${settings.featureOn(sessionId, from, 'antidemote')?'ON':'OFF'}`);
        }
        break;
      }

      case 'forceviewonce': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          if (settings.featureOn(sessionId, from, 'forceviewonce')) return reply('Force View-Once is already ON.');
          settings.setFeature(sessionId, from, 'forceviewonce', true);
          return reply('👁️ Force view-once is *active*.');
        }
        if (opt === 'off') {
          if (!settings.featureOn(sessionId, from, 'forceviewonce')) return reply('Force View-Once is already OFF.');
          settings.setFeature(sessionId, from, 'forceviewonce', false);
          return reply('👁️ Force view-once disabled.');
        }
        await reply(`Usage: ${prefix}forceviewonce on|off`);
        break;
      }

      case 'antifamily': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          if (settings.featureOn(sessionId, from, 'antifamily')) return reply('Anti-Family is already ON.');
          settings.setFeature(sessionId, from, 'antifamily', true);
          return reply('👪 Family-insult filter *active*.');
        }
        if (opt === 'off') {
          if (!settings.featureOn(sessionId, from, 'antifamily')) return reply('Anti-Family is already OFF.');
          settings.setFeature(sessionId, from, 'antifamily', false);
          return reply('👪 Family-insult filter disabled.');
        }
        if (opt === 'limit') {
          const n = parseInt(args[1], 10);
          if (!n || n < 1) return reply(`Example: ${prefix}antifamily limit 3`);
          settings.set(sessionId, from, 'antifamily_warnlimit', n);
          return reply(`Anti-Family limit is ${n}.`);
        }
        await reply(`Usage: ${prefix}antifamily on|off|limit`);
        break;
      }

      case 'muteuser': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to manage muted messages.');
        const target = getTargetJids(m, args)[0];
        if (!target) return reply(`Tag or reply:\n${prefix}muteuser @user\n${prefix}muteuser @user 30m\n${prefix}muteuser @user 2h`);
        const timeArg = (args.find((a) => /\d/.test(a) && !a.startsWith('@')) || '').toLowerCase();
        let durationMs = 0; // permanent by default
        if (timeArg) {
          const n = parseInt(timeArg, 10);
          if (timeArg.endsWith('s')) durationMs = n * 1000;
          else if (timeArg.endsWith('m')) durationMs = n * 60 * 1000;
          else if (timeArg.endsWith('h')) durationMs = n * 60 * 60 * 1000;
          else if (timeArg.endsWith('d')) durationMs = n * 24 * 60 * 60 * 1000;
          else durationMs = n * 60 * 1000; // plain number = minutes
        }
        const alreadyMuted = [target, String(target).replace(/[^0-9]/g, '')].some(j => j && settings.isUserMuted(sessionId, from, j));
        if (alreadyMuted) return reply('User is already muted.');
        settings.muteUser(sessionId, from, target, durationMs);
        // store by number too
        const tn = String(target).replace(/[^0-9]/g, '');
        if (tn) settings.muteUser(sessionId, from, tn, durationMs);
        if (durationMs > 0) {
          const mins = Math.round(durationMs / 60000);
          await reply(`🔇 Muted @${target.split('@')[0]} for *${mins} min*\nMessages will be deleted until unmute or time ends.`, { mentions: [target] });
        } else {
          await reply(`🔇 @${target.split('@')[0]} is *muted*\nMessages will be deleted until you unmute.`, { mentions: [target] });
        }
        break;
      }

      case 'unmuteuser': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        const target = getTargetJids(m, args)[0];
        if (!target) return reply(`Mention, reply, or use a number: ${prefix}unmuteuser @user`);
        const resolved = await resolvePhoneJid(sock, target, participants) || target;
        const num = String(resolved).replace(/[^0-9]/g, '');
        if (!settings.isUserMuted(sessionId, from, resolved) && !settings.isUserMuted(sessionId, from, num)) {
          return reply('User is already unmuted.');
        }
        settings.unmuteUser(sessionId, from, resolved);
        settings.unmuteUser(sessionId, from, num);
        await reply(`🔊 @${String(resolved).split('@')[0]} is unmuted.`, { mentions: [resolved] });
        break;
      }


      case 'goodbye': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          settings.setGoodbye(sessionId, from, true);
          await reply('✅ Goodbye enabled.');
        } else if (opt === 'off') {
          settings.setGoodbye(sessionId, from, false);
          await reply('✅ Goodbye disabled.');
        } else {
          await reply(`Usage: ${prefix}goodbye`);
        }
        break;
      }

      case 'linkgc': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to retrieve the invite link.');
        try {
          const code = await sock.groupInviteCode(from);
          const link = `https://chat.whatsapp.com/${code}`;
          // send with link preview
          await sock.sendMessage(from, {
            text: `🔗 *Group Invite*\n${link}`,
            linkPreview: null
          }, { quoted: m });
          // also plain so WA generates preview
          await sock.sendMessage(from, { text: link }, { quoted: m });
        } catch (e) {
          await reply('❌ Failed to get invite link.');
        }
        break;
      }

      case 'revoke': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        try {
          await sock.groupRevokeInvite(from);
          const code = await sock.groupInviteCode(from);
          await reply(`✅ Group link reset.\n🔗 https://chat.whatsapp.com/${code}`);
        } catch (e) {
          await reply('❌ Failed to reset link.');
        }
        break;
      }

      case 'close': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        await sock.groupSettingUpdate(from, 'locked');
        await reply('🔒 Group settings locked. Only admins can edit info.');
        break;
      }

      case 'open': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        await sock.groupSettingUpdate(from, 'unlocked');
        await reply('🔓 Group settings unlocked.');
        break;
      }



      case 'setname': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        if (!q) return reply(`Example: ${prefix}setgcname New Group Name`);
        await sock.groupUpdateSubject(from, q);
        await reply(`✅ Group name changed to: *${q}*`);
        break;
      }

      case 'setdesc': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        if (!q) return reply(`Example: ${prefix}setgcdesc New description`);
        await sock.groupUpdateDescription(from, q);
        await reply('✅ Group description updated.');
        break;
      }

      case 'listadmins': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        const admins = groupAdmins || [];
        if (!admins.length) return reply('No admins found.');
        const list = admins.map((a, i) => `${i+1}. @${a.split('@')[0]}`).join('\n');
        await sendProfessionalText(sock, from, `👑 *Group Administrators*\n\n${list}`, { mentions: admins, quoted: m });
        break;
      }

      case 'setgcpp': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const ctx = m.message?.extendedTextMessage?.contextInfo || {};
        const quoted = ctx.quotedMessage;
        const img = quoted?.imageMessage || m.message?.imageMessage;
        if (!img) return reply(`Reply to an image: ${prefix}setgcpp`);
        try {
          const { downloadContentFromMessage } = await getBaileys();
          const stream = await downloadContentFromMessage(img, 'image');
          let buffer = Buffer.alloc(0);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
          await sock.updateProfilePicture(from, buffer);
          await reply('✅ Group picture updated.');
        } catch (e) {
          console.error('setgcpp:', e.message);
          await reply('❌ Failed to update group picture.');
        }
        break;
      }

      case 'delpp': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        try {
          await sock.removeProfilePicture(from);
          await reply('✅ Group picture removed.');
        } catch (e) {
          await reply('❌ Failed to remove group picture.');
        }
        break;
      }

      case 'requests': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        try {
          const reqs = await sock.groupRequestParticipantsList(from);
          if (!reqs?.length) return reply('✅ No pending join requests.');
          const lines = reqs.map((r, i) => `${i + 1}. @${String(r.jid || r.id || '').split('@')[0]}`);
          const mentions = reqs.map(r => r.jid || r.id).filter(Boolean);
          await sendProfessionalText(sock, from, `📥 *Pending Join Requests*\n\n${lines.join('\n')}`, { mentions, quoted: m });
        } catch (e) {
          await reply('❌ Failed to fetch join requests.');
        }
        break;
      }

      case 'approveall': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        try {
          const reqs = await sock.groupRequestParticipantsList(from);
          const ids = reqs.map(r => r.jid || r.id).filter(Boolean);
          if (!ids.length) return reply('✅ No pending join requests.');
          await sock.groupRequestParticipantsUpdate(from, ids, 'approve');
          await reply(`✅ Approved *${ids.length}* join request${ids.length === 1 ? '' : 's'}.`);
        } catch (e) {
          await reply('❌ Failed to approve requests.');
        }
        break;
      }

      case 'rejectall': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        try {
          const reqs = await sock.groupRequestParticipantsList(from);
          const ids = reqs.map(r => r.jid || r.id).filter(Boolean);
          if (!ids.length) return reply('✅ No pending join requests.');
          await sock.groupRequestParticipantsUpdate(from, ids, 'reject');
          await reply(`✅ Rejected *${ids.length}* join request${ids.length === 1 ? '' : 's'}.`);
        } catch (e) {
          await reply('❌ Failed to reject requests.');
        }
        break;
      }

      case 'approve': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const action = command.startsWith('approve') ? 'approve' : 'reject';
        const target = getTargetJids(m, args)[0];
        if (!target) return reply(`Tag or reply to the requester: ${prefix}${action}`);
        try {
          const result = await sock.groupRequestParticipantsUpdate(from, [target], action);
          const ok = result?.[0]?.status === '200' || result?.[0]?.status === 200;
          await reply(ok ? `✅ Request ${action}d.` : `❌ Could not ${action} the request.`);
        } catch (e) {
          await reply(`❌ Failed to ${action} request.`);
        }
        break;
      }

      case 'membermode': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const mode = String(args[0] || '').toLowerCase();
        if (!['admin', 'all'].includes(mode)) return reply(`Usage: ${prefix}membermode admin|all`);
        try {
          await sock.groupMemberAddMode(from, mode === 'admin' ? 'admin_add' : 'all_member_add');
          await reply(mode === 'admin' ? '🔒 Only admins can add members.' : '🔓 Members can add members.');
        } catch (e) {
          await reply('❌ Failed to change member add mode.');
        }
        break;
      }

      case 'ephemeral': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const mode = String(args[0] || '').toLowerCase();
        const seconds = { off: 0, '24h': 86400, '7d': 604800, '90d': 7776000 }[mode];
        if (seconds === undefined) return reply(`Usage: ${prefix}ephemeral off|24h|7d|90d`);
        try {
          await sock.groupToggleEphemeral(from, seconds);
          await reply(seconds ? `✅ Disappearing messages: *${mode}*.` : '✅ Disappearing messages: *off*.');
        } catch (e) {
          await reply('❌ Failed to change disappearing messages.');
        }
        break;
      }

      case 'groupstats': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        const meta = groupMetadata || {};
        const stats = settings.getDailyStats(sessionId, from);
        const active = Object.entries(stats.users || {})
          .sort((a, b) => Number(b[1]?.count || 0) - Number(a[1]?.count || 0))
          .slice(0, 10);
        const mentionPairs = [];
        for (const [jid, info] of active) {
          const resolved = await resolvePhoneJid(sock, jid, meta.participants || participants || []);
          mentionPairs.push({
            jid: resolved || jid,
            count: Number(info?.count || 0)
          });
        }
        let text =
          `📊 *𝙅𝙄𝙉𝙓 𝙆9 GROUP STATS*\n\n` +
          `👥 Members: *${(meta.participants || participants || []).length}*\n` +
          `💬 Messages today: *${stats.messages || 0}*\n` +
          `🤖 Bot commands: *${stats.commands || 0}*\n` +
          `🎮 Games played: *${stats.games || 0}*\n` +
          `⚠️ Warnings: *${stats.warnings || 0}*\n` +
          `🔗 Links blocked: *${stats.linkBlocks || 0}*\n\n` +
          `🔥 *MOST ACTIVE TODAY*\n`;
        if (!mentionPairs.length) {
          text += `No activity tracked yet.`;
        } else {
          mentionPairs.forEach((entry, i) => {
            text += `${i + 1}. @${String(entry.jid).split('@')[0]} — *${entry.count}* msgs\n`;
          });
        }
        await sock.sendMessage(from, { text, mentions: mentionPairs.map(x => x.jid) }, { quoted: m });
        break;
      }


      case 'rules': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        const rules = settings.get(sessionId, from, 'grouprules', 'No group rules have been set.');
        await reply(`📜 *Group Rules*\n\n${rules}`);
        break;
      }

      case 'setrules': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!q) return reply(`Usage: ${prefix}setrules <rules>`);
        settings.set(sessionId, from, 'grouprules', q.slice(0, 4000));
        await reply('✅ Group rules saved.');
        break;
      }

      case 'groupinfo': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        const meta = groupMetadata || {};
        const text =
          `📋 *Group Info*\n\n` +
          `Name: ${meta.subject || '-'}\n` +
          `ID: ${from}\n` +
          `Members: ${(meta.participants||[]).length}\n` +
          `Admins: ${(groupAdmins||[]).length}\n` +
          `Desc: ${meta.desc || '-'}`;
        await reply(text);
        break;
      }


      case 'del': {
        if (!isGroup && !isOwner && !isModUser) return reply('Use in a group or as owner.');
        if (isGroup && !isAdmin && !isSudoUser && !isOwner && !isModUser) {
          return reply('Only admins or sudo can delete messages.');
        }
        const ctx = m.message?.extendedTextMessage?.contextInfo || {};
        if (!ctx.stanzaId) return reply(`Reply to the message you want to delete:\n${prefix}del`);
        const quotedKey = buildDeleteKey(from, ctx, null, botJid);
        if (!quotedKey?.id) return reply(`Reply to the message you want to delete:\n${prefix}del`);
        let targetDeleted = false;
        try {
          await sock.sendMessage(from, { delete: quotedKey });
          targetDeleted = true;
        } catch (e) {
          console.error(`[${sessionId}] del target delete failed:`, e?.message || e);
        }
        let commandDeleted = false;
        try {
          if (m?.key?.id) {
            await sock.sendMessage(from, { delete: m.key });
            commandDeleted = true;
          }
        } catch (e) {
          console.error(`[${sessionId}] del command delete failed:`, e?.message || e);
        }
        if (!targetDeleted) return reply('❌ Could not delete the quoted message. Bot may need to be admin.');
        if (!commandDeleted) console.warn(`[${sessionId}] .del removed target but could not remove command message`);
        break;
      }

      case 'warns': {
        // canonical warn command
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        const warns = settings.getWarns(sessionId, from) || {};
        const entries = Object.entries(warns).filter(([, c]) => Number(c) > 0);
        const limit = settings.get(sessionId, from, 'warnlimit', 3);
        if (!entries.length) return reply(`✅ No active warnings.\nLimit: *${limit}*`);
        let body = `⚠️ *Warn list* (limit ${limit})\n━━━━━━━━━━━━\n`;
        entries.sort((a, b) => Number(b[1]) - Number(a[1]));
        for (const [jid, c] of entries.slice(0, 30)) {
          body += `• @${String(jid).split('@')[0]} — *${c}/${limit}*\n`;
        }
        await sendProfessionalText(sock, from, body, { mentions: entries.map(e => e[0]), quoted: m });
        break;
      }

      case 'autodl': {
        if (!isOwner && !isModUser && !(isGroup && isAdmin) && !isSudoUser) {
          return reply('Only owner/mod/admin can toggle autodl.');
        }
        const opt = (args[0] || '').toLowerCase();
        const scope = isGroup ? from : 'bot';
        if (opt === 'on') {
          settings.set(sessionId, scope, 'autodl', true);
          if (!isGroup) settings.set(sessionId, 'bot', 'autodl', true);
          return reply('✅ Auto-download *ON*\nYT / TikTok / Instagram links will download automatically.');
        }
        if (opt === 'off') {
          settings.set(sessionId, scope, 'autodl', false);
          if (!isGroup) settings.set(sessionId, 'bot', 'autodl', false);
          return reply('✅ Auto-download *OFF*');
        }
        const on = settings.get(sessionId, scope, 'autodl', settings.get(sessionId, 'bot', 'autodl', false));
        return reply(`Autodl: *${on ? 'ON' : 'OFF'}*\nUsage: ${prefix}autodl on|off`);
      }

      case 'warn': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        const target = getTargetJids(m, args)[0];
        if (!target) return reply(`Tag or reply: ${prefix}warn @user`);

        // If .warn was used as a reply, delete the offending message too
        // (needs the bot to be a group admin — WhatsApp only allows
        // "delete for everyone" on someone else's message for admins).
        const warnCtx = m.message?.extendedTextMessage?.contextInfo || {};
        if (warnCtx.stanzaId && isBotAdmin) {
          try {
            await sock.sendMessage(from, {
              delete: {
                remoteJid: from,
                fromMe: false,
                id: warnCtx.stanzaId,
                participant: warnCtx.participant || target
              }
            });
          } catch (e) {
            console.error('warn delete error:', e.message);
          }
        }

        const count = settings.addWarn(sessionId, from, target);
        const limit = settings.get(sessionId, from, 'warnlimit', 3);
        const reasonArgs = [...args];
        if (reasonArgs[0] && /^(?:@?\d{8,15})$/.test(reasonArgs[0])) reasonArgs.shift();
        if (reasonArgs[0] && /^\d+$/.test(reasonArgs[0]) && reasonArgs.length > 1) reasonArgs.shift();
        const reason = reasonArgs.join(' ').trim();
        const reasonLine = reason ? `\nReason: ${reason}` : '';
        await reply(`⚠️ *Warning Issued*\n\n@${target.split('@')[0]} · warning ${count}/${limit}${reasonLine}`, { mentions: [target] });
        if (count >= limit && isBotAdmin) {
          await sock.groupParticipantsUpdate(from, [target], 'remove');
          settings.resetWarn(sessionId, from, target);
          await reply(`🛡️ *Warning Limit Reached*\n\n@${target.split('@')[0]} was removed from the group.`, { mentions: [target] });
        }
        break;
      }

      case 'resetwarn': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        const target = getTargetJids(m, args)[0];
        if (!target) return reply(`Usage: ${prefix}resetwarn @user [link|groupmention|antitag|antibot|antifamily|groupstatus|viewonce]`);
        const featureAliases = {
          link: 'antilink', antilink: 'antilink',
          groupmention: 'antigroupmention', antigroupmention: 'antigroupmention',
          antitag: 'antitag', tag: 'antitag',
          antibot: 'antibot', bot: 'antibot',
          antifamily: 'antifamily', family: 'antifamily',
          groupstatus: 'antigroupstatus', status: 'antigroupstatus',
          viewonce: 'forceviewonce', forceviewonce: 'forceviewonce'
        };
        const requestedFeature = (args.find(a => featureAliases[String(a).toLowerCase()]) || '').toLowerCase();
        if (requestedFeature) {
          const feature = featureAliases[requestedFeature];
          const left = settings.decrementFeatureWarn(sessionId, from, feature, target);
          return reply(`✅ Removed 1 ${requestedFeature} warning from @${target.split('@')[0]}.
Remaining: *${left}*`, { mentions: [target] });
        }
        const left = settings.decrementWarn(sessionId, from, target);
        await reply(left > 0
          ? `✅ Removed 1 warning from @${target.split('@')[0]}.
Remaining: *${left}*`
          : `✅ No manual warnings remain for @${target.split('@')[0]}.`,
          { mentions: [target] });
        break;
      }

      case 'warnlist': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        const warns = settings.getWarns(sessionId, from) || {};
        const entries = Object.entries(warns).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
        if (!entries.length) return reply('✅ No active warnings in this group.');
        const limit = settings.get(sessionId, from, 'warnlimit', 3);
        let text = `⚠️ *Warn List* (limit ${limit})\n\n`;
        entries.forEach(([jid, c], i) => {
          text += `${i + 1}. @${String(jid).split('@')[0]} — *${c}* warn(s)\n`;
        });
        await reply(text, { mentions: entries.map(([j]) => j) });
        break;
      }

      case 'warnlimit': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        const n = parseInt(args[0], 10);
        if (!n || n < 1) return reply(`Example: ${prefix}warnlimit
│ ${prefix}slowmode
│ ${prefix}antispam 3`);
        settings.set(sessionId, from, 'warnlimit', n);
        await reply(`✅ Warn limit set to *${n}*`);
        break;
      }

      // ---------- SLOWMODE ----------
      case 'slowmode': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        const arg = (args[0] || '').toLowerCase();
        if (!arg || arg === 'status') {
          const on = settings.get(sessionId, from, 'slowmode', false);
          const sec = settings.get(sessionId, from, 'slowmode_sec', 10);
          return reply(`🐢 *Slowmode*\nStatus: ${on ? 'ON' : 'OFF'}\nDelay: *${sec}* seconds between messages\n\nUsage:\n${prefix}slowmode on\n${prefix}slowmode off\n${prefix}slowmode 15  (set delay seconds)`);
        }
        if (arg === 'on') {
          settings.set(sessionId, from, 'slowmode', true);
          const sec = settings.get(sessionId, from, 'slowmode_sec', 10);
          return reply(`✅ Slowmode *ON* — members wait *${sec}s* between messages.\nChange delay: ${prefix}slowmode 20`);
        }
        if (arg === 'off') {
          settings.set(sessionId, from, 'slowmode', false);
          return reply('✅ Slowmode *OFF*');
        }
        const sec = parseInt(arg, 10);
        if (!sec || sec < 1) return reply(`Example: ${prefix}slowmode 10`);
        settings.set(sessionId, from, 'slowmode_sec', sec);
        settings.set(sessionId, from, 'slowmode', true);
        await reply(`✅ Slowmode *ON* — delay set to *${sec}* seconds.`);
        break;
      }

      // ---------- ANTISPAM ----------
      case 'antispam': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        const arg = (args[0] || '').toLowerCase();
        const count = settings.get(sessionId, from, 'antispam_count', 5);
        const window = settings.get(sessionId, from, 'antispam_window', 10);
        const action = settings.get(sessionId, from, 'antispam_action', 'warn');
        if (!arg || arg === 'status') {
          const on = settings.get(sessionId, from, 'antispam', false);
          return reply(
            `🚫 *Anti-Spam*\nStatus: ${on ? 'ON' : 'OFF'}\nTrigger: *${count}* messages in *${window}* seconds\nAction: *${action}*\n\n` +
            `Usage:\n${prefix}antispam on\n${prefix}antispam off\n${prefix}antispam 5 10  (msgs window)\n${prefix}antispam action warn|kick|delete`
          );
        }
        if (arg === 'on') {
          settings.set(sessionId, from, 'antispam', true);
          return reply(`✅ Anti-spam *ON*\n${count} msgs / ${window}s → ${action}`);
        }
        if (arg === 'off') {
          settings.set(sessionId, from, 'antispam', false);
          return reply('✅ Anti-spam *OFF*');
        }
        if (arg === 'action') {
          const a = (args[1] || '').toLowerCase();
          if (!['warn', 'kick', 'delete'].includes(a)) return reply('Use: warn | kick | delete');
          settings.set(sessionId, from, 'antispam_action', a);
          return reply(`✅ Anti-spam action set to *${a}*`);
        }
        // antispam 5 10
        const c = parseInt(args[0], 10);
        const w = parseInt(args[1], 10);
        if (c >= 2 && w >= 3) {
          settings.set(sessionId, from, 'antispam_count', c);
          settings.set(sessionId, from, 'antispam_window', w);
          settings.set(sessionId, from, 'antispam', true);
          return reply(`✅ Anti-spam *ON*\nTrigger: *${c}* messages in *${w}* seconds`);
        }
        await reply(`Example: ${prefix}antispam 5 10`);
        break;
      }


      case 'punch': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to remove members.');
        const rawCode = String(args[0] || '').trim();
        const code = rawCode.replace(/[^0-9]/g, '');
        if (!code || code.length < 1 || code.length > 4) {
          return reply(`Usage: ${prefix}punch +91\nExample: ${prefix}punch 91`);
        }
        const botNum = String(botNumber || '').replace(/[^0-9]/g, '');
        const adminSet = new Set(groupAdmins.map(j => String(j).replace(/[^0-9]/g, '')));
        const targets = participants.map(p => p.id).filter(id => {
          const n = String(id || '').replace(/[^0-9]/g, '');
          if (!n || !n.startsWith(code)) return false;
          if (n === botNum) return false;
          if (adminSet.has(n)) return false;
          return true;
        });
        if (!targets.length) return reply(`🌍 No non-admin members found with country code +${code}.`);
        await reply(`🌍 Removing *${targets.length}* member(s) with country code *+${code}*...`);
        let removed = 0;
        for (let i = 0; i < targets.length; i += 5) {
          const batch = targets.slice(i, i + 5);
          try {
            const result = await sock.groupParticipantsUpdate(from, batch, 'remove');
            if (Array.isArray(result)) removed += result.filter(x => x?.status === '200' || x?.status === 200).length || batch.length;
            else removed += batch.length;
          } catch (e) {
            console.warn(`[${sessionId}] punch +${code} failed: ${e.message}`);
          }
        }
        return reply(`✅ Country-code punch complete.\nCode: *+${code}*\nRemoved: *${removed}*`);
      }

      case 'kick': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to remove members.');
        // Support multiple mentions: ?kick @a @b @c
        let targets = getTargetJids(m, args);
        if (!targets.length) return reply(`Mention, reply, or use a number: ${prefix}kick @user`);
        targets = (await Promise.all(targets.map(t => resolvePhoneJid(sock, t, participants) || t))).filter(Boolean);
        // Don't kick bot or session owner
        targets = targets.filter(t => {
          const num = t.replace(/[^0-9]/g, '');
          return num !== botNumber;
        });
        if (!targets.length) return reply('No valid targets to kick.');
        await sock.groupParticipantsUpdate(from, targets, 'remove');
        const tags = targets.map(t => `@${t.split('@')[0]}`).join(' ');
        await reply(`🛡️ *Members Removed*\n\n${targets.map(t => `• @${t.split('@')[0]}`).join('\n')}`, { mentions: targets });
        break;
      }

      case 'kickall': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const toKick = participants
          .map(p => p.id)
          .filter(id => {
            const num = id.replace(/[^0-9]/g, '');
            if (num === botNumber) return false;
            if (num === botNumber) return false;
            if (groupAdmins.includes(id)) return false; // keep admins
            return true;
          });
        if (!toKick.length) return reply('No members to kick.');
        await reply(`⚠️ Kicking ${toKick.length} members (admins & owners skipped)...`);
        // Kick in batches of 5
        for (let i = 0; i < toKick.length; i += 5) {
          const batch = toKick.slice(i, i + 5);
          await sock.groupParticipantsUpdate(from, batch, 'remove').catch(() => {});
          await sleep(1500);
        }
        await reply(`✅ Kickall done. Removed ${toKick.length} members.`);
        break;
      }

      case 'promote': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        let targets = getTargetJids(m, args);
        if (!targets.length) return reply(`Mention, reply, or use a number: ${prefix}promote @user`);
        const resolvedTargets = [];
        for (const t of targets) {
          const resolved = await resolvePhoneJid(sock, t, participants) || await normalizeParticipantJid(sock, t, participants) || t;
          if (resolved) resolvedTargets.push(resolved);
        }
        targets = [...new Set(resolvedTargets)];
        if (!targets.length) return reply('❌ Could not resolve the target user.');
        const alreadyAdmin = targets.filter(t => participants.some(p => p?.admin && listHasId([p.id, p.jid, p.phoneNumber, p.lid].filter(Boolean), t)));
        const toPromote = targets.filter(t => !alreadyAdmin.some(a => identity.identitiesMatch(a, t)));
        if (!toPromote.length) return reply(`ℹ️ ${alreadyAdmin.map(t => `@${t.split('@')[0]}`).join(', ')} ${alreadyAdmin.length === 1 ? 'is' : 'are'} already admin.`, { mentions: alreadyAdmin });
        for (const t of toPromote) markBotAction(sessionId, from, t, 'promote');
        try {
          await safeGroupParticipantsUpdate(sock, from, toPromote, 'promote', 'promote command');
        } catch (e) {
          for (const t of toPromote) botActionIgnore.delete(`${sessionId}|${from}|${t}|promote`);
          return reply('❌ WhatsApp rejected the promote request. The bot stayed online; check that it is still a group admin and try again.');
        }
        break;
      }

      case 'demote': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo.');
        let targets = getTargetJids(m, args);
        if (!targets.length) return reply(`Mention, reply, or use a number: ${prefix}demote @user`);
        const resolvedTargets = [];
        for (const t of targets) {
          const resolved = await resolvePhoneJid(sock, t, participants) || await normalizeParticipantJid(sock, t, participants) || t;
          if (resolved) resolvedTargets.push(resolved);
        }
        targets = [...new Set(resolvedTargets)];
        if (!targets.length) return reply('❌ Could not resolve the target user.');
        const currentAdmins = targets.filter(t => participants.some(p => p?.admin && listHasId([p.id, p.jid, p.phoneNumber, p.lid].filter(Boolean), t)));
        if (!currentAdmins.length) return reply('ℹ️ None of the selected users are currently group admins.');
        for (const t of currentAdmins) markBotAction(sessionId, from, t, 'demote');
        try {
          await safeGroupParticipantsUpdate(sock, from, currentAdmins, 'demote', 'demote command');
        } catch (e) {
          for (const t of currentAdmins) botActionIgnore.delete(`${sessionId}|${from}|${t}|demote`);
          return reply('❌ WhatsApp rejected the demote request. The bot stayed online; check that it is still a group admin and try again.');
        }
        break;
      }

      case 'hidetag': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        const members = [];
        for (const p of participants || []) {
          const jid = await resolvePhoneJid(sock, p.id || p.jid, participants) || p.id || p.jid;
          if (jid) members.push(jid);
        }
        const unique = [...new Set(members)];
        await sock.sendMessage(from, {
          text: q || '‎',
          mentions: unique
        }, { quoted: m });
        break;
      }

      case 'listonline': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        try {
          // Presence isn't always accurate on multi-device; show members as best-effort
          const online = [];
          for (const p of participants) {
            try {
              const pres = await sock.presenceSubscribe(p.id).catch(() => null);
            } catch {}
          }
          // Fallback: list all members (WhatsApp does not reliably expose online list via Baileys)
          const list = participants.map((p, i) => `${i+1}. @${p.id.split('@')[0]}`).join('\n');
          await sock.sendMessage(from, {
            text: `🟢 *Members (${participants.length})*\n_Online status is limited by WhatsApp._\n\n${list}`,
            mentions: participants.map(p => p.id)
          }, { quoted: m });
        } catch (e) {
          await reply('❌ Could not fetch member list.');
        }
        break;
      }

      case 'listoffline': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        await reply('⚠️ WhatsApp does not provide a reliable offline list via the bot API.\nUse `?listonline` for the member list.');
        break;
      }


      case 'weather': {
        if (!q) return reply('Example: ' + prefix + 'weather Lagos');
        try {
          const url = 'https://wttr.in/' + encodeURIComponent(q) + '?format=j1';
          const { data } = await axios.get(url, {
            timeout: 20000,
            headers: { 'User-Agent': 'JinxK9Bot/1.0' }
          });
          const cur = data.current_condition && data.current_condition[0];
          const area = data.nearest_area && data.nearest_area[0];
          const day = data.weather && data.weather[0];
          if (!cur) return reply('Location not found. Try a city name.');
          const city = (area && area.areaName && area.areaName[0] && area.areaName[0].value) || q;
          const region = (area && area.region && area.region[0] && area.region[0].value) || '-';
          const country = (area && area.country && area.country[0] && area.country[0].value) || '-';
          const cond = (cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value) || '-';
          let text = '🌤️ *Weather — ' + city + '*\n';
          text += '📍 ' + region + ', ' + country + '\n';
          text += '🌡️ Temp: *' + cur.temp_C + '°C* (feels ' + cur.FeelsLikeC + '°C) / ' + cur.temp_F + '°F\n';
          text += '☁️ ' + cond + '\n';
          text += '💧 Humidity: ' + cur.humidity + '%\n';
          text += '💨 Wind: ' + cur.windspeedKmph + ' km/h ' + (cur.winddir16Point || '') + '\n';
          text += '👁️ Visibility: ' + (cur.visibility || '-') + ' km\n';
          if (day) text += '📊 Today: H ' + day.maxtempC + '°C / L ' + day.mintempC + '°C\n';
          text += '🕐 ' + (cur.localObsDateTime || cur.observation_time || '');
          await reply(text);
        } catch (e) {
          console.error('weather:', e.message);
          await reply('❌ Could not fetch weather. Try another city name.');
        }
        break;
      }

      case 'football': {
        if (!q) return reply(`Examples:\n${prefix}score Man City vs Arsenal\n${prefix}match Chelsea\n${prefix}football Liverpool`);
                try {
          // Use free football data APIs
          const query = q.toLowerCase();
          // Try football-data style via public mirrors / web
          const searchUrl = `https://www.thesportsdb.com/api/v1/json/3/searchevents.php?e=${encodeURIComponent(q.replace(/\s+vs\.?\s+/i, ' vs '))}`;
          const { data } = await axios.get(searchUrl, { timeout: 15000 });
          const events = data?.event || [];
          if (!events.length) {
            // fallback search by team name
            const teamUrl = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(q)}`;
            const teamRes = await axios.get(teamUrl, { timeout: 12000 }).catch(() => null);
            const team = teamRes?.data?.teams?.[0];
            if (team) {
              const nextUrl = `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${team.idTeam}`;
              const nextRes = await axios.get(nextUrl, { timeout: 12000 });
              const next = nextRes.data?.events?.[0];
              if (next) {
                return reply(
                  `⚽ *${next.strEvent}*\n` +
                  `League: ${next.strLeague || '-'}\n` +
                  `Date: ${next.dateEvent || '-'} ${next.strTime || ''}\n` +
                  `Venue: ${next.strVenue || '-'}\n` +
                  `Status: ${next.strStatus || 'Scheduled'}`
                );
              }
            }
            return reply('No match found. Try: Man City vs Arsenal');
          }
          const e = events[0];
          const score = (e.intHomeScore != null && e.intAwayScore != null)
            ? `${e.intHomeScore} - ${e.intAwayScore}`
            : 'Not started / N/A';
          await reply(
            `⚽ *${e.strEvent || q}*\n` +
            `Score: *${score}*\n` +
            `League: ${e.strLeague || '-'}\n` +
            `Date: ${e.dateEvent || '-'} ${e.strTime || ''}\n` +
            `Venue: ${e.strVenue || '-'}\n` +
            `Status: ${e.strStatus || e.strProgress || '-'}`
          );
        } catch (e) {
          console.error('football error:', e.message);
          await reply('❌ Could not fetch match data. Try again later.');
        }
        break;
      }

      case 'totalmessage': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        // Message counts stored in settings per group
        const counts = settings.get(sessionId, from, 'msgcounts', {}) || {};
        const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (!entries.length) {
          return reply('No message data yet. Counts start tracking from now.\nMembers need to chat after the bot joined.');
        }
        const top = entries.slice(0, 20);
        const mentions = top.map(([jid]) => jid);
        let text = `📊 *Top Messages in this group*\n\n`;
        top.forEach(([jid, count], i) => {
          text += `${i + 1}. @${jid.split('@')[0]} — *${count}* msgs\n`;
        });
        text += `\n_Total tracked users: ${entries.length}_`;
        await sock.sendMessage(from, { text, mentions }, { quoted: m });
        break;
      }

      // ---------- WORD GAME ----------
      case 'wordgame': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        const sub = String(args[0] || 'start').toLowerCase();
        if (sub === 'end' || sub === 'stop') {
          wordgame.endGame(sessionId, from);
          return reply('🛑 Word game ended.');
        }
        if (sub === 'status') {
          const g = wordgame.getGame(sessionId, from);
          if (!g) return reply('🎮 No word game running.');
          return reply(`🎮 Word Game: *${g.status.toUpperCase()}*\nPlayers: *${g.players.length}*\nRound: *${g.round}*`);
        }
        const mode = ['easy', 'normal', 'hard'].includes(sub) ? sub : 'normal';
        const res = wordgame.createGame(sessionId, from, sender, mode);
        if (res.error) return reply(res.error);
        const g = res.game;
        settings.recordDailyEvent(sessionId, from, 'games', 1);
        g.joinTimer = setTimeout(async () => {
          try {
            const started = wordgame.startPlaying(sessionId, from);
            if (started.error) {
              await sock.sendMessage(from, { text: `❌ ${started.error}` });
              return;
            }
            if (started.winner) {
              await sock.sendMessage(from, {
                text: `🏆 Winner: @${started.winner.jid.split('@')[0]}!`,
                mentions: [started.winner.jid]
              });
              return;
            }
            if (started.success) {
              const p = started.player;
              await sock.sendMessage(from, {
                text:
                  `🏁 *WCG STARTED!* (${started.playersLeft} players)\n\n` +
                  `🔤 Round *${started.round}* — minimum *${started.minLength} letters*\n` +
                  `🎯 @${p.jid.split('@')[0]}: give a word starting with *${started.letter}*\n` +
                  `⏱ ${started.turnSeconds}s`,
                mentions: [p.jid]
              });
              scheduleWordTurn(sock, sessionId, from);
            }
          } catch (e) {
            console.error('wordgame autostart:', e.message);
          }
        }, g.joinSeconds * 1000);

        await reply(
          `🎮 *WORD CHAIN GAME*\n\n` +
          `Type *join* to enter.\n` +
          `⏱ Join window: *${g.joinSeconds}s*\n` +
          `👥 Anyone can join — no sudo required.\n\n` +
          `When the game starts, players take turns in join order.\n` +
          `Round 1: minimum *3 letters* → then 4 → 5 → 6...`
        );
        break;
      }

      case 'startgame': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        const started = wordgame.startPlaying(sessionId, from);
        if (started.error) return reply(started.error);
        if (started.winner) {
          return reply(`🏆 Winner: @${started.winner.jid.split('@')[0]}`, { mentions: [started.winner.jid] });
        }
        if (started.success) {
          const p = started.player;
          await reply(
            `🏁 *Game started!*\n\n🔤 Round *${started.round}* — minimum *${started.minLength} letters*\n🎯 @${p.jid.split('@')[0]} — word starting with *${started.letter}*\n⏱ ${started.turnSeconds}s`,
            { mentions: [p.jid] }
          );
          scheduleWordTurn(sock, sessionId, from);
        }
        break;
      }

      case 'endgame': {
        wordgame.endGame(sessionId, from);
        await reply('🛑 Word game ended.');
        break;
      }

      case 'tictactoe': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (args[0] === 'end') {
          tictactoe.endGame(sessionId, from);
          return reply('🗑️ TicTacToe ended.');
        }
        const opponent = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!opponent) return reply(`Tag someone: ${prefix}tictactoe @user`);
        const res = tictactoe.createGame(sessionId, from, sender, opponent);
        if (res.error) return reply(res.error);
        await sock.sendMessage(from, {
          text: `🎮 *TicTacToe*\n\n❌ @${sender.split('@')[0]}\n⭕ @${opponent.split('@')[0]}\n\n${tictactoe.render(res.game.board)}\n\n@${sender.split('@')[0]} starts. Type a number 1-9`,
          mentions: [sender, opponent]
        });
        break;
      }

      // ---------- VIEW ONCE ----------
      case 'vv': {
        const contextInfo = m.message?.extendedTextMessage?.contextInfo || {};
        if (!contextInfo.quotedMessage) {
          return reply(`Reply to a view-once message with ${prefix}vv`);
        }
        // Open IN THE SAME CHAT (group or DM) — not private DM
        const ok = await openViewOnce(sock, m, contextInfo, from, reply, {
          silent: false,
          caption: '🔓 View once opened'
        });
        if (!ok) await reply('❌ Could not open that view-once.');
        break;
      }

      // ---------- STICKER ----------
      case 's': {
        // Support: reply to image/video, or send with media
        // Custom pack/author: .s MyPack,Author  OR  .s MyPack|Author  OR  .s MyPack;Author
        const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage
          || m.message?.imageMessage
          || m.message?.videoMessage
          || null;
        const mediaMsg = quoted || msg;
        // Unwrap view-once if present
        const unwrapped =
          mediaMsg?.viewOnceMessage?.message ||
          mediaMsg?.viewOnceMessageV2?.message ||
          mediaMsg?.viewOnceMessageV2Extension?.message ||
          mediaMsg;
        const type = Object.keys(unwrapped || {}).find(k => ['imageMessage', 'videoMessage'].includes(k));
        if (!type) {
          return reply(`Reply to an image/video with ${prefix}s\nOptional: ${prefix}s PackName,Author`);
        }
        try {
          const { downloadContentFromMessage } = await getBaileys();
          const stream = await downloadContentFromMessage(unwrapped[type], type.replace('Message', ''));
          let buffer = Buffer.from([]);
          for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
          }
          if (!buffer.length) throw new Error('Downloaded media was empty');

          // Parse custom pack / author from command text
          let pack = config.BOT_NAME || '𝙅𝙄𝙉𝙓 𝙆9';
          let author = config.OWNER_NAME || 'PRIME';
          if (q && q.trim()) {
            const parts = q.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
            if (parts[0]) pack = parts[0];
            if (parts[1]) author = parts[1];
          }

          const { Sticker, StickerTypes } = require('wa-sticker-formatter');
          const sticker = new Sticker(buffer, {
            pack,
            author,
            type: StickerTypes?.FULL || 'full',
            quality: 75
          });
          const stickerBuffer = await sticker.toBuffer();
          if (!stickerBuffer?.length) throw new Error('Sticker conversion returned empty buffer');
          await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
        } catch (e) {
          console.error('sticker error:', e);
          const detail = String(e?.message || e || 'unknown error');
          const mediaEngineError = /sharp|libvips|node-gyp|sharp-linux|sharp-linux-arm|Cannot find module.*sharp/i.test(detail);
          await reply(mediaEngineError
            ? '❌ Sticker creation failed\nMedia engine is unavailable on the server.'
            : '❌ Failed to create sticker. Please try again.');
        }
        break;
      }

      // ---------- DOWNLOADER (basic) ----------
      case 'play': {
        if (!q) return reply(`Example: ${prefix}play Alan Walker Faded`);
        try {
          let video = null;
          try {
            const directId = /(?:v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{6,})/i.exec(q)?.[1];
            if (directId) {
              video = { url: `https://www.youtube.com/watch?v=${directId}`, title: 'YouTube audio' };
            } else {
              const search = await yts(q);
              video = search.videos?.[0] || null;
            }
          } catch (e) {
            console.error('play yts failed:', e?.message || e);
          }
          if (!video?.url) {
            try { video = await searchYouTube(q); } catch (e) {
              console.error('play searchYouTube failed:', e?.message || e);
            }
          }
          if (!video?.url) return reply('❌ No YouTube result found. Try a different name or a direct link.');

          const titleSafe = (t) => String(t || 'song').replace(/[\\/:*?"<>|]/g, '').slice(0, 80);
          const errors = [];

          // Path A — plain: resolve URL then send as { audio: { url } } (standard Baileys URL audio)
          try {
            const remote = await downloadMp3Url(video.url);
            const fileName = `${titleSafe(remote.title || video.title)}.mp3`;
            try {
              await sock.sendMessage(from, {
                audio: { url: remote.url },
                mimetype: 'audio/mpeg',
                fileName,
                ptt: false
              }, { quoted: m });
              break;
            } catch (sendUrlErr) {
              errors.push('url-send: ' + (sendUrlErr?.message || sendUrlErr));
              // Path B — buffer the remote file then send (more reliable on some hosts)
              const buf = await downloadRemoteAudio(remote.url);
              await sock.sendMessage(from, {
                audio: buf,
                mimetype: 'audio/mpeg',
                fileName,
                ptt: false
              }, { quoted: m });
              break;
            }
          } catch (providerErr) {
            errors.push('provider: ' + (providerErr?.message || providerErr));
            console.error('play provider failed:', providerErr?.message || providerErr);
          }

          // Path C — youtubei.js + FFmpeg local convert
          try {
            const { buffer, title } = await downloadMp3(video.url);
            await sock.sendMessage(from, {
              audio: buffer,
              mimetype: 'audio/mpeg',
              fileName: `${titleSafe(title || video.title)}.mp3`,
              ptt: false
            }, { quoted: m });
            break;
          } catch (ytErr) {
            errors.push('youtubei: ' + (ytErr?.message || ytErr));
            console.error('play youtubei failed:', ytErr?.message || ytErr);
          }

          await reply(
            '❌ Could not download that song.\n' +
            `Tried: ${errors.slice(0, 3).join(' | ') || 'all providers'}\n` +
            `Tip: try \`${prefix}ytmp3 <youtube-link>\` or another song name.`
          );
        } catch (e) {
          console.error('play error:', e?.stack || e?.message || e);
          await reply(`❌ Play failed: ${e.message || 'unknown error'}`);
        } finally {
        }
        break;
      }

      case 'ytmp3': {
        if (!q || !isUrl(q)) return reply(`Example: ${prefix}ytmp3 https://youtu.be/xxxx`);
        await reply('⏳ Downloading...');
        try {
          const apis = [
            `https://apis.davidcyriltech.my.id/download/ytmp3?url=${encodeURIComponent(q)}`,
            `https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(q)}`,
            `https://api.agatz.xyz/api/ytmp3?url=${encodeURIComponent(q)}`,
            `https://ytupscaler.com/api/raw?url=${encodeURIComponent(q)}&type=audio`,
            `https://api.nyxs.pw/dl/yt-mp3?url=${encodeURIComponent(q)}`,
            `https://api.akuari.my.id/downloader/youtubeaudio?link=${encodeURIComponent(q)}`
          ];
          let audioUrl = null;
          for (const api of apis) {
            try {
              const { data } = await axios.get(api, { timeout: 45000, headers: { 'User-Agent': 'Mozilla/5.0' } });
              audioUrl =
                data?.result?.download_url ||
                data?.result?.url ||
                data?.data?.dl ||
                data?.data?.url ||
                data?.url ||
                data?.download ||
                data?.link ||
                null;
              if (audioUrl && String(audioUrl).startsWith('http')) break;
              audioUrl = null;
            } catch (e) {}
          }
          if (!audioUrl) return reply('❌ Download failed. API may be down — try again later.');
          await sock.sendMessage(from, {
            audio: { url: audioUrl },
            mimetype: 'audio/mpeg',
            fileName: 'audio.mp3'
          }, { quoted: m });
        } catch (e) {
          await reply('❌ Failed to download MP3.');
        }
        break;
      }

      case 'ytmp4': {
        if (!q || !isUrl(q)) return reply(`Example: ${prefix}ytmp4 https://youtu.be/xxxx`);
                try {
          const apis = [
            `https://apis.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(q)}`,
            `https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(q)}`
          ];
          let videoUrl = null;
          for (const api of apis) {
            try {
              const { data } = await axios.get(api, { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } });
              videoUrl =
                data?.result?.download_url ||
                data?.result?.url ||
                data?.data?.dl ||
                data?.data?.url ||
                data?.url ||
                data?.download ||
                null;
              if (videoUrl && String(videoUrl).startsWith('http')) break;
              videoUrl = null;
            } catch (e) {}
          }
          if (!videoUrl) return reply('❌ Download failed. Try again later.');
          await sock.sendMessage(from, {
            video: { url: videoUrl },
            caption: '✅ YouTube video'
          }, { quoted: m });
        } catch (e) {
          await reply('❌ Failed to download MP4.');
        }
        break;
      }


      // ---------- NEW V1.3.8 COMMANDS ----------
      case 'ytsearch': {
        if (!q) return reply(`Example: ${prefix}ytsearch Alan Walker Faded`);
        try {
          const list = await searchYouTubeList(q, 5);
          if (!list.length) return reply('No YouTube results.');
          let body = `🔍 *YouTube Search*\nQuery: *${q}*\n━━━━━━━━━━━━\n`;
          list.forEach((v, i) => {
            body += `*${i + 1}.* ${v.title}\n`;
            if (v.artist) body += `   👤 ${v.artist}\n`;
            if (v.timestamp) body += `   ⏱️ ${v.timestamp}`;
            if (v.views) body += ` | 👁️ ${v.views}`;
            body += `\n   🔗 ${v.url}\n\n`;
          });
          body += `_Use ${prefix}play <name> or ${prefix}video <name> to download_`;
          await reply(body);
        } catch (e) {
          await reply('❌ Search failed. Try again.');
        }
        break;
      }

      case 'songinfo': {
        if (!q) return reply(`Example: ${prefix}songinfo Shape of You`);
        try {
          const list = await searchYouTubeList(q, 1);
          const v = list[0];
          if (!v?.url) return reply('No result found.');
          const caption =
            `🎵 *Song Info*\n` +
            `━━━━━━━━━━━━\n` +
            `📌 Title: *${v.title}*\n` +
            (v.artist ? `👤 Artist: *${v.artist}*\n` : '') +
            (v.timestamp ? `⏱️ Duration: *${v.timestamp}*\n` : '') +
            (v.views ? `👁️ Views: *${v.views}*\n` : '') +
            (v.ago ? `📅 Uploaded: *${v.ago}*\n` : '') +
            `🔗 ${v.url}\n` +
            `━━━━━━━━━━━━\n` +
            `_Download: ${prefix}play ${v.title}_`;
          if (v.thumbnail) {
            try {
              await sock.sendMessage(from, { image: { url: v.thumbnail }, caption }, { quoted: m });
              break;
            } catch (_) {}
          }
          await reply(caption);
        } catch (e) {
          await reply('❌ Could not fetch song info.');
        }
        break;
      }

      case 'video': {
        if (!q) return reply(`Example: ${prefix}video Alan Walker Faded`);
        try {
          let url = q;
          let title = 'video';
          if (!isUrl(q) || !/youtube\.com|youtu\.be/i.test(q)) {
            const list = await searchYouTubeList(q, 1);
            if (!list[0]?.url) return reply('No YouTube video found.');
            url = list[0].url;
            title = list[0].title || title;
          }
          const apis = [
            `https://apis.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(url)}`,
            `https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(url)}`
          ];
          let videoUrl = null;
          for (const api of apis) {
            try {
              const { data } = await axios.get(api, { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } });
              videoUrl =
                data?.result?.download_url ||
                data?.result?.url ||
                data?.data?.dl ||
                data?.data?.url ||
                data?.url ||
                data?.download ||
                null;
              if (videoUrl && String(videoUrl).startsWith('http')) break;
              videoUrl = null;
            } catch (_) {}
          }
          if (!videoUrl) return reply('❌ Video download failed. Try a direct link with ' + prefix + 'ytmp4');
          await sock.sendMessage(from, {
            video: { url: videoUrl },
            caption: `🎬 *${title}*\n${url}`
          }, { quoted: m });
        } catch (e) {
          await reply('❌ Failed to download video.');
        } finally {
        }
        break;
      }

      case 'spotify': {
        if (!q) return reply(`Example:\n${prefix}spotify Blinding Lights\n${prefix}spotify https://open.spotify.com/track/...`);
        try {
          const query = await extras.resolveSpotifyToQuery(q);
          if (!query) return reply('❌ Could not resolve Spotify track. Try the song name.');
          const list = await searchYouTubeList(query, 1);
          const v = list[0];
          if (!v?.url) return reply('No YouTube match for that Spotify track.');
          await reply(`🎧 *Spotify → YouTube*\n*${v.title}*\n${v.url}\n\n_Downloading audio..._`);
          try {
            const remote = await downloadMp3Url(v.url);
            await sock.sendMessage(from, {
              audio: await downloadRemoteAudio(remote.url),
              mimetype: 'audio/mpeg',
              fileName: `${String(remote.title || v.title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.mp3`,
              ptt: false
            }, { quoted: m });
          } catch (providerErr) {
            const { buffer, title } = await downloadMp3(v.url);
            await sock.sendMessage(from, {
              audio: buffer,
              mimetype: 'audio/mpeg',
              fileName: `${String(title || v.title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.mp3`,
              ptt: false
            }, { quoted: m });
          }
        } catch (e) {
          await reply(`❌ Spotify download failed: ${e.message || 'try again'}`);
        } finally {
        }
        break;
      }

      case 'lyrics': {
        if (!q) return reply(`Example: ${prefix}lyrics Alan Walker - Faded`);
        try {
          const data = await extras.fetchLyrics(q);
          let lyrics = data.lyrics || '';
          if (lyrics.length > 3500) lyrics = lyrics.slice(0, 3500) + '\n\n_...truncated_';
          await reply(
            `📝 *Lyrics*\n` +
            `*${data.title}* — ${data.artist}\n` +
            `━━━━━━━━━━━━\n` +
            lyrics
          );
        } catch (e) {
          await reply('❌ Lyrics not found. Try: Artist - Song title');
        } finally {
        }
        break;
      }

      case 'quote': {
        const ctx =
          m.message?.extendedTextMessage?.contextInfo ||
          m.message?.imageMessage?.contextInfo ||
          {};
        const quoted = ctx.quotedMessage;
        let quoteText = '';
        let quoteName = ctx.participant || '';
        if (quoted) {
          quoteText =
            quoted.conversation ||
            quoted.extendedTextMessage?.text ||
            quoted.imageMessage?.caption ||
            quoted.videoMessage?.caption ||
            quoted.buttonsResponseMessage?.selectedDisplayText ||
            '';
        }
        if (!quoteText && q) quoteText = q;
        if (!quoteText) return reply(`Reply to a message with ${prefix}quote\nOr: ${prefix}quote your text`);
        quoteText = String(quoteText).trim().slice(0, 800);
        const who = quoteName
          ? `@${String(quoteName).split('@')[0]}`
          : (m.pushName || 'Someone');
        const card =
          `╭───『 💬 𝙌𝙐𝙊𝙏𝙀 』───╮\n` +
          `│\n` +
          `│ "${quoteText}"\n` +
          `│\n` +
          `│ — ${who}\n` +
          `│\n` +
          `╰──────────────────╯`;
        await sock.sendMessage(from, {
          text: card,
          mentions: quoteName ? [quoteName] : []
        }, { quoted: m });
        break;
      }

      case 'remind': {
        if (!q) {
          const list = extras.listReminders(sessionId, from);
          if (!list.length) {
            return reply(
              `Example: ${prefix}remind 10m Check the oven\n` +
              `${prefix}remind 2h Call back\n` +
              `${prefix}remind 1d Pay bill\n\n` +
              `Units: s, m, h, d (min 5s, max 7 days)`
            );
          }
          let body = `⏰ *Active reminders*\n━━━━━━━━━━━━\n`;
          list.forEach((r, i) => {
            const left = Math.max(0, r.when - Date.now());
            const mins = Math.round(left / 60000);
            body += `*${i + 1}.* ${r.text}\n   in ~${mins}m\n`;
          });
          return reply(body);
        }
        const parts = q.trim().split(/\s+/);
        const dur = extras.parseDuration(parts[0]);
        if (!dur) return reply(`Invalid time. Example: ${prefix}remind 15m Drink water`);
        const msg = parts.slice(1).join(' ').trim() || 'Reminder';
        try {
          const r = extras.addReminder({
            sessionId,
            chatId: from,
            createdBy: sender,
            text: msg,
            ms: dur
          });
          const mins = Math.round(dur / 60000);
          const when = new Date(r.when).toLocaleString();
          await reply(`✅ Reminder set\n📌 ${msg}\n⏱️ in ~${mins < 1 ? Math.round(dur/1000) + 's' : mins + 'm'}\n📅 ${when}`);
        } catch (e) {
          await reply(`❌ ${e.message || 'Could not set reminder'}`);
        }
        break;
      }

      case 'wallpaper': {
        try {
          const wp = await extras.fetchWallpaper(q || '');
          await sock.sendMessage(from, {
            image: { url: wp.url },
            caption:
              `🖼️ *Wallpaper*\n` +
              (q ? `Query: *${q}*\n` : '') +
              (wp.resolution ? `📐 ${wp.resolution}\n` : '') +
              (wp.page ? `🔗 ${wp.page}` : '')
          }, { quoted: m });
        } catch (e) {
          await reply('❌ Wallpaper fetch failed. Try again.');
        } finally {
        }
        break;
      }

      case 'tiktok': {
        if (!q || !isUrl(q)) return reply(`Example: ${prefix}tiktok https://vt.tiktok.com/xxxx`);
        try {
          const apis = [
            async () => {
              const res = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(q)}`, { timeout: 30000 });
              const d = res.data?.data;
              if (d?.play) return { url: d.play, title: d.title || '' };
              return null;
            },
            async () => {
              const res = await axios.get(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(q)}`, { timeout: 30000 });
              const d = res.data?.data || res.data?.result || res.data;
              const url = d?.play || d?.video || d?.url || d?.download;
              if (url) return { url, title: d?.title || '' };
              return null;
            },
            async () => {
              const res = await axios.get(`https://apis.davidcyriltech.my.id/download/tiktok?url=${encodeURIComponent(q)}`, { timeout: 30000 });
              const d = res.data?.result || res.data?.data || res.data;
              const url = d?.video || d?.play || d?.url || d?.download;
              if (url) return { url, title: d?.title || '' };
              return null;
            }
          ];
          let got = null;
          for (const fn of apis) {
            try {
              got = await fn();
              if (got?.url) break;
            } catch (e) {}
          }
          if (!got?.url) return reply('❌ Could not fetch TikTok video. APIs may be down.');
          await sock.sendMessage(from, {
            video: { url: got.url },
            caption: `✅ TikTok\n${got.title || ''}`
          }, { quoted: m });
        } catch (e) {
          console.error('tiktok:', e.message);
          await reply('❌ TikTok download failed.');
        }
        break;
      }

      case 'ig': {
        if (!q || !isUrl(q)) return reply(`Example: ${prefix}ig https://www.instagram.com/reel/xxxx`);
        await reply('⏳ Instagram download is available. Use a reliable public API or scraper on your server.');
        break;
      }


      case 'url': {
        const qmsg = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!qmsg) return reply(`Reply to an image/video/document with ${prefix}url`);
        try {
                    const type = Object.keys(qmsg).find(k => k.endsWith('Message')) || Object.keys(qmsg)[0];
          const media = qmsg[type];
          if (!media) return reply('Unsupported media.');
          const { downloadContentFromMessage } = await getBaileys();
          const stream = await downloadContentFromMessage(media, type.replace('Message', ''));
          let buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
          // Upload to free host
          const FormData = require('form-data');
          const form = new FormData();
          form.append('file', buffer, { filename: 'file.bin' });
          let link = null;
          try {
            const up = await axios.post('https://catbox.moe/user/api.php', form, {
              headers: form.getHeaders(),
              params: { reqtype: 'fileupload' },
              timeout: 60000,
              maxBodyLength: Infinity
            });
            // catbox expects field differently - try litterbox / uguu fallback
          } catch (e) {}
          try {
            const FormData2 = require('form-data');
            const form2 = new FormData2();
            form2.append('files[]', buffer, { filename: 'upload.jpg' });
            const up2 = await axios.post('https://uguu.se/upload.php', form2, {
              headers: form2.getHeaders(),
              timeout: 60000,
              maxBodyLength: Infinity
            });
            link = up2.data?.files?.[0]?.url || up2.data?.files?.[0]?.hash;
          } catch (e) {}
          if (!link) {
            try {
              const FormData3 = require('form-data');
              const form3 = new FormData3();
              form3.append('reqtype', 'fileupload');
              form3.append('fileToUpload', buffer, { filename: 'file.jpg' });
              const up3 = await axios.post('https://catbox.moe/user/api.php', form3, {
                headers: form3.getHeaders(),
                timeout: 60000,
                maxBodyLength: Infinity
              });
              if (typeof up3.data === 'string' && up3.data.startsWith('http')) link = up3.data.trim();
            } catch (e) {}
          }
          if (!link) return reply('❌ Upload failed. Try again later.');
          await reply(`🔗 *URL:*\n${link}`);
        } catch (e) {
          console.error('url error', e.message);
          await reply('❌ Could not create URL.');
        }
        break;
      }

      case 'tinyurl': {
        if (!q || !isUrl(q)) return reply(`Example: ${prefix}tinyurl https://example.com`);
        try {
          const { data } = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(q)}`, { timeout: 15000 });
          await reply(`🔗 Short URL:\n${data}`);
        } catch (e) {
          await reply('❌ Shorten failed.');
        }
        break;
      }

      case 'calc': {
        if (!q) return reply(`Example: ${prefix}calc 2+2*5`);
        try {
          const expr = String(q).replace(/[^0-9+\-*/().%\s]/g, '').trim();
          if (!expr) return reply('Invalid expression.');
          const result = safeCalc(expr);
          await reply(`🧮 ${expr} = *${result}*`);
        } catch (e) {
          await reply(`Invalid expression: ${e.message || 'try again'}`);
        }
        break;
      }

      case 'define': {
        if (!q) return reply(`Example: ${prefix}define hello`);
        try {
          const { data } = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q)}`, { timeout: 15000 });
          const entry = data[0];
          const meaning = entry.meanings?.[0];
          const def = meaning?.definitions?.[0]?.definition || 'No definition';
          await reply(`📖 *${entry.word}*\n${meaning?.partOfSpeech || ''}\n\n${def}`);
        } catch (e) {
          await reply('Word not found.');
        }
        break;
      }

      case 'wiki': {
        if (!q) return reply(`Example: ${prefix}wiki Nigeria`);
        try {
          const { data } = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`, { timeout: 15000 });
          await reply(`📚 *${data.title}*\n\n${data.extract || 'No summary.'}\n\n${data.content_urls?.desktop?.page || ''}`);
        } catch (e) {
          await reply('Not found on Wikipedia.');
        }
        break;
      }

      case 'bible': {
        if (!q) return reply(`Example: ${prefix}bible John 3:16`);
        try {
          const ref = q.replace(/\s+/g, '+');
          const { data } = await axios.get(`https://bible-api.com/${encodeURIComponent(q)}`, { timeout: 15000 });
          await reply(`📖 *${data.reference}*\n\n${data.text}\n_${data.translation_name || ''}_`);
        } catch (e) {
          await reply('Verse not found.');
        }
        break;
      }

      case 'style': {
        try {
          const { listall, fancytext } = require('./lib/fonts/style-font');
          if (!q) {
            let sample = '𝙅𝙄𝙉𝙓 𝙆9';
            let list = `┏━━━❰ *FANCY FONTS* ❱━━━┓\n┃ Example: ${prefix}style 3 Hello\n┃\n`;
            listall(sample).forEach((txt, num) => {
              list += `┃ ${String(num + 1).padStart(2, '0')}. ${txt}\n`;
            });
            list += `┗━━━❖ 𝙅𝙄𝙉𝙓 𝙆9 V1 ❖━━━┛`;
            return reply(list);
          }
          const parts = q.trim().split(/\s+/);
          const num = parseInt(parts[0], 10);
          if (isNaN(num) || num < 1) {
            return reply(mxErr(`Invalid font number.\nExample: ${prefix}style 1 𝙅𝙄𝙉𝙓 𝙆9`));
          }
          const phrase = parts.slice(1).join(' ').trim();
          if (!phrase) {
            return reply(mxErr(`Provide text after the number.\nExample: ${prefix}style 5 𝙅𝙄𝙉𝙓 𝙆9 Bot`));
          }
          const styles = listall(phrase);
          if (num > styles.length) {
            return reply(mxErr(`Font *${num}* not found.\nUse ${prefix}style to see 1–${styles.length}`));
          }
          const out = fancytext(phrase, num);
          await reply(
            `┏━━━❰ *FONT ${num}* ❱━━━┓\n` +
            `┃ ${out}\n` +
            `┗━━━❖ 𝙅𝙄𝙉𝙓 𝙆9 V1 ❖━━━┛`
          );
        } catch (e) {
          console.error('font:', e);
          await reply(mxErr(`Font failed: ${e.message}`));
        }
        break;
      }

      case 'readmore': {
        if (!q) return reply(`Example: ${prefix}readmore Hello | Hidden text`);
        const parts = q.split('|');
        const visible = (parts[0] || '').trim();
        const hidden = (parts[1] || parts[0] || '').trim();
        const more = String.fromCharCode(8206).repeat(4001);
        await reply(visible + more + hidden);
        break;
      }

      case 'tts': {
        if (!q) return reply(`Example: ${prefix}tts Hello world`);
        try {
          const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(q.slice(0, 180))}&tl=en&client=tw-ob`;
          const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://translate.google.com/',
              'Accept': '*/*'
            }
          });
          const buffer = Buffer.from(res.data);
          if (!buffer.length) return reply('❌ TTS failed (empty audio).');
          await sock.sendMessage(
            from,
            { audio: buffer, mimetype: 'audio/mpeg', ptt: false, fileName: 'tts.mp3' },
            { quoted: m }
          );
        } catch (e) {
          console.error('tts error:', e.message);
          await reply('❌ TTS failed. Try shorter text.');
        }
        break;
      }

      case 'menuimage': {
        return reply('🔒 Menu image is locked to the official 𝙅𝙄𝙉𝙓 𝙆9 image.');
      }

      case 'setvar': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        if (!q || !q.includes('=')) {
          return reply(
            `*Set variables*\n\n` +
            `${prefix}setvar menuimage=https://example.com/pic.jpg\n` +
            `${prefix}setvar prefix=?\n\n` +
            `_menuimage changes this session menu image_`
          );
        }
        const eq = q.indexOf('=');
        const key = q.slice(0, eq).trim().toLowerCase();
        const val = q.slice(eq + 1).trim();
        if (key === 'menuimage' || key === 'menuimg') {
          await reply('🔒 Menu image is locked to the official 𝙅𝙄𝙉𝙓 𝙆9 image.');
        } else if (key === 'prefix') {
          settings.setPrefix(sessionId, val);
          await reply(`✅ Prefix set to: ${val}`);
        } else {
          settings.set(sessionId, 'bot', key, val);
          await reply(`✅ Set ${key}`);
        }
        break;
      }

      case 'ban': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const tuser = getTargetJids(m, args)[0];
        if (!tuser) return reply(`Mention, reply, or use a number: ${prefix}ban @user`);
        const banned = settings.get(sessionId, 'bot', 'banned', []) || [];
        if (!banned.includes(tuser)) banned.push(tuser);
        settings.set(sessionId, 'bot', 'banned', banned);
        await reply(`🚫 Banned @${tuser.split('@')[0]}`, { mentions: [tuser] });
        break;
      }

      case 'unban': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const tuser = getTargetJids(m, args)[0];
        if (!tuser) return reply(`Mention, reply, or use a number: ${prefix}unban @user`);
        let banned = settings.get(sessionId, 'bot', 'banned', []) || [];
        banned = banned.filter(j => j !== tuser);
        settings.set(sessionId, 'bot', 'banned', banned);
        await reply(`✅ Unbanned @${tuser.split('@')[0]}`, { mentions: [tuser] });
        break;
      }

      case 'stats': {
        const counts = settings.get(sessionId, from, 'msgcounts', {}) || {};
        const messages = Object.values(counts).reduce((a,b)=>a+Number(b||0),0);
        const elevated = db.getSessionElevated(sessionId);
        const groups = new Set(Object.keys(settings.get(sessionId, 'bot', 'knownGroups', {}) || {})).size;
        const mem = process.memoryUsage();
        await reply(
          `📊 *𝙅𝙄𝙉𝙓 𝙆9 SESSION STATS*\n\n` +
          `📱 Session: ${botNumber || sessionId}\n` +
          `⏱️ Runtime: ${sessionRuntime.display(sessionId)}\n` +
          `📨 Messages: ${messages}\n` +
          `👥 Groups tracked: ${groups}\n` +
          `👑 Sudo: ${(elevated.sudo || []).length}\n` +
          `🛡️ Mod: ${(elevated.mods || []).length}\n` +
          `💾 RSS: ${(mem.rss/1024/1024).toFixed(1)} MB\n` +
          `🟢 Connection: ${sock.user ? 'ONLINE' : 'OFFLINE'}`
        );
        break;
      }

      case 'chatbot': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyMod);
        const sub = String(args[0] || 'status').toLowerCase();
        if (sub === 'on' || sub === 'all') {
          const st = chatbot.setMode(sessionId, from, 'all');
          return reply(`🤖 Chatbot: *ON*\nMode: *ALL MESSAGES*\nMemory: ${st.memoryTurns} turns`);
        }
        if (sub === 'mention' || sub === 'mentions') {
          const st = chatbot.setMode(sessionId, from, 'mention');
          return reply(`🤖 Chatbot: *ON*\nMode: *MENTION ONLY*\nMemory: ${st.memoryTurns} turns`);
        }
        if (sub === 'off') {
          chatbot.setMode(sessionId, from, 'off');
          return reply('🤖 Chatbot: *OFF*');
        }
        if (sub === 'reset' || sub === 'clear') {
          chatbot.reset(sessionId, from);
          return reply('🧠 Chatbot memory cleared.');
        }
        const st = chatbot.status(sessionId, from);
        return reply(`🤖 Chatbot: *${st.enabled ? 'ON' : 'OFF'}*\nMode: *${st.mode.toUpperCase()}*\nMemory: ${st.memoryTurns} turns\n\nUse ${prefix}chatbot on | mention | off | reset`);
      }

      // ---------- WEB SEARCH ----------
      case 'search': {
        if (!q) return reply(`Usage: ${prefix}${command} <search query>`);
        try {
          const results = await searchWeb(q, 6);
          let out = `🔎 *WEB SEARCH*\n\n`;
          results.forEach((r, i) => {
            out += `${i + 1}. *${r.title}*\n${r.snippet || 'No snippet available.'}\n${r.url}\n\n`;
          });
          await reply(out.trim());
        } catch (e) {
          await reply(`❌ Search failed: ${e.message || 'try again later.'}`);
        }
        break;
      }

      // ---------- AI IMAGE GENERATION ----------
      case 'imagine': {
        if (!q) return reply(`Usage: ${prefix}imagine <image prompt>`);
        try {
          const generated = await generateImage(q);
          await sock.sendMessage(from, {
            image: generated.buffer,
            caption: `🎨 *𝙅𝙄𝙉𝙓 𝙆9 AI Image*\n${q.slice(0, 500)}`
          }, { quoted: m });
        } catch (e) {
          await reply(`❌ Image generation failed: ${e.message || 'provider unavailable.'}`);
        } finally {
        }
        break;
      }

      // ---------- TRANSLATE ----------
      case 'translate': {
        let sourceText = q;
        let targetLanguage = args[0] || '';
        const ctx = m.message?.extendedTextMessage?.contextInfo || {};
        if (ctx.quotedMessage && !q) {
          const qm = ctx.quotedMessage;
          sourceText =
            qm.conversation ||
            qm.extendedTextMessage?.text ||
            qm.imageMessage?.caption ||
            qm.videoMessage?.caption ||
            qm.documentMessage?.caption || '';
          targetLanguage = 'English';
        } else if (ctx.quotedMessage && args[0]) {
          const qm = ctx.quotedMessage;
          sourceText =
            qm.conversation ||
            qm.extendedTextMessage?.text ||
            qm.imageMessage?.caption ||
            qm.videoMessage?.caption ||
            qm.documentMessage?.caption || '';
        } else if (q) {
          targetLanguage = String(args[0] || 'English');
          sourceText = args.slice(1).join(' ');
        }
        if (!sourceText) return reply(`Reply to text with ${prefix}translate French\nor use ${prefix}translate French Hello`);
        if (!targetLanguage) targetLanguage = 'English';
        try {
          const translated = await ai.ask(null,
            `Translate the following text into ${targetLanguage}. Preserve the meaning and natural tone. Return only the translation.\n\n${sourceText}`
          );
          await reply(`🌍 *${targetLanguage}*\n\n${translated}`);
        } catch (e) {
          await reply(`❌ Translation failed: ${e.message || 'AI provider unavailable.'}`);
        }
        break;
      }

      // ---------- VOICE TRANSCRIPTION ----------
      case 'transcribe': {
        const ctx = m.message?.extendedTextMessage?.contextInfo || {};
        const quoted = ctx.quotedMessage;
        const audioMsg = quoted?.audioMessage || msg?.audioMessage;
        if (!audioMsg) return reply(`Reply to a voice note/audio with ${prefix}transcribe`);
        try {
          const { downloadContentFromMessage } = await getBaileys();
          const stream = await downloadContentFromMessage(audioMsg, 'audio');
          const buffer = await collectMediaWithLimit(stream, 25 * 1024 * 1024, 'voice note');
          const mime = audioMsg.mimetype || 'audio/ogg; codecs=opus';
          const transcript = await transcribe(buffer, mime);
          await reply(`📝 *TRANSCRIPTION*\n\n${transcript}`);
        } catch (e) {
          await reply(`❌ Transcription failed: ${e.message || 'voice provider unavailable.'}`);
        } finally {
        }
        break;
      }

      // ---------- PIN MESSAGE ----------
      case 'pin': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const ctx = m.message?.extendedTextMessage?.contextInfo || {};
        if (!ctx.stanzaId) return reply(`Reply to a message with ${prefix}pin 24h`);
        const raw = String(args[0] || '24h').toLowerCase();
        const times = { '24h': 86400, '1d': 86400, '7d': 604800, '30d': 2592000 };
        const seconds = times[raw];
        if (!seconds) return reply(`Use: ${prefix}pin 24h | ${prefix}pin 7d | ${prefix}pin 30d`);
        const key = {
          remoteJid: from,
          id: ctx.stanzaId,
          fromMe: !!ctx.fromMe,
          ...(ctx.participant ? { participant: ctx.participant } : {})
        };
        try {
          await sock.sendMessage(from, { pin: key, type: 1, time: seconds });
          await reply(`📌 Pinned for *${raw === '1d' ? '24h' : raw}*.`);
        } catch (e) {
          await reply(`❌ Pin failed: ${e.message || 'WhatsApp rejected the pin.'}`);
        }
        break;
      }

      case 'unpin': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        const ctx = m.message?.extendedTextMessage?.contextInfo || {};
        if (!ctx.stanzaId) return reply(`Reply to a pinned message with ${prefix}unpin`);
        const key = {
          remoteJid: from,
          id: ctx.stanzaId,
          fromMe: !!ctx.fromMe,
          ...(ctx.participant ? { participant: ctx.participant } : {})
        };
        try {
          await sock.sendMessage(from, { pin: key, type: 0, time: 0 });
          await reply('📌 Message unpinned.');
        } catch (e) {
          await reply(`❌ Unpin failed: ${e.message || 'WhatsApp rejected it.'}`);
        }
        break;
      }

      case 'gpt': {
        // Free public AI gateway style — no personal API key required
        const prompt = q || '';
        if (!prompt) return reply(`Usage: ${prefix}${command} <question>\nOr reply to a message.`);
        const providerMap = {
          ai: null,
          gpt: 'openai',
          openai: 'openai',
          gemini: 'gemini',
          deepseek: 'deepseek',
          mistral: 'mistral',
          llama: 'llama',
          coder: 'coder',
          polli: 'pollinations',
          pollinations: 'pollinations'
        };
        const provider = providerMap[command] ?? null;
        try {
          const answer = await ai.ask(provider, prompt);
          const label = provider || 'auto';
          await reply(`🤖 *${String(label).toUpperCase()}*\n\n${answer}`);
        } catch (e) {
          console.error('ai cmd:', e.message);
          await reply(`⚠️ ${e.message || 'AI gateway unavailable. Try again in a moment.'}`);
        } finally {
        }
        break;
      }

      case 'aistatus': {
        const available = ai.configuredProviders();
        await reply(
          `🤖 *𝙅𝙄𝙉𝙓 𝙆9 AI Status*\n\n` +
          `Mode: *Free public gateway*\n` +
          `No personal API key required.\n\n` +
          `Available routes:\n` +
          available.map(n => `• ${n}`).join('\n') +
          `\n\nOptional: add your own keys in config.env for higher limits.\n` +
          `Commands: ${prefix}ai ${prefix}gpt ${prefix}gemini ${prefix}deepseek ${prefix}mistral ${prefix}llama ${prefix}coder`
        );
        break;
      }

      case 'quiz': {
        const qs = [
          ['What is the capital of Nigeria?', ['Lagos','Abuja','Kano','Ibadan'], 'Abuja'],
          ['How many bits are in one byte?', ['4','8','16','32'], '8'],
          ['Which planet is known as the Red Planet?', ['Earth','Venus','Mars','Jupiter'], 'Mars']
        ];
        const item = qs[Math.floor(Math.random()*qs.length)];
        await reply(`🎯 *𝙅𝙄𝙉𝙓 𝙆9 QUIZ*\n\n${item[0]}\n\n1️⃣ ${item[1][0]}\n2️⃣ ${item[1][1]}\n3️⃣ ${item[1][2]}\n4️⃣ ${item[1][3]}\n\nReply with the answer.\nCorrect answer: *${item[2]}*`);
        break;
      }

      case 'rps': {
        const choices = ['rock','paper','scissors'];
        const pick = choices[Math.floor(Math.random()*3)];
        await reply(`🎮 *Rock Paper Scissors*\n\n𝙅𝙄𝙉𝙓 𝙆9 picked: *${pick.toUpperCase()}*\nUse: ${prefix}rps rock|paper|scissors`);
        break;
      }


      case 'getdevice': {
        // Prefer quoted message id for accuracy
        const ctx = m.message?.extendedTextMessage?.contextInfo ||
          m.message?.imageMessage?.contextInfo ||
          m.message?.videoMessage?.contextInfo ||
          m.message?.stickerMessage?.contextInfo || {};
        const id = ctx.stanzaId || m.key?.id || '';

        // Use the exact device classifier shipped by the installed Baileys
        // version. This avoids the bot having a second, potentially stale copy
        // of the regex rules.
        let device = 'unknown';
        try {
          const B = await getBaileys();
          if (typeof B.getDevice === 'function') device = B.getDevice(id);
        } catch (e) {}
        // If the installed fork does not export getDevice, retain the official
        // Baileys 7.x rules as a fallback.
        if (device === 'unknown') {
          const s = String(id || '');
          if (/^3A.{18}$/.test(s)) device = 'ios';
          else if (/^3E.{20}$/.test(s)) device = 'web';
          else if (/^(.{21}|.{32})$/.test(s)) device = 'android';
          else if (/^(3F|.{18}$)/.test(s)) device = 'desktop';
        }

        const who = ctx.participant || sender;
        const map = {
          ios: 'iOS', android: 'Android', web: 'Web', desktop: 'Desktop', unknown: 'Unknown'
        };
        const label = map[device] || 'Unknown';
        const resolvedWho = await resolvePhoneJid(sock, who, participants) || who;
        await reply(
          `📱 Device: *${label}*\nUser: @${String(resolvedWho).split('@')[0]}\n_Reply to a message for best accuracy._`,
          { mentions: [resolvedWho] }
        );
        break;
      }

      case 'repo': {
        const repoText =
          `⚡ *${config.BOT_NAME}*\n\n` +
          `Developed by *${config.OWNER_NAME}*\n` +
          `Telegram bot: https://t.me/${config.BOT_USERNAME}\n` +
          `Owner: ${config.OWNER_TELEGRAM}\n\n` +
          `Click the Telegram link to use my bots.\n` +
          `Multi-session WhatsApp + Telegram control panel.\n\n` +
          `Group: ${config.GROUP_INVITE}`;
        await sendRichLink(sock, from, repoText, m);
        break;
      }

      case 'afk': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        const reason = q || 'Away';
        const afkMap = settings.get(sessionId, from, 'afk', {}) || {};
        afkMap[sender] = { reason, since: Date.now() };
        settings.set(sessionId, from, 'afk', afkMap);
        await reply(`💤 @${senderNumber} is now AFK\nReason: ${reason}\n_Only applies in this group._`, { mentions: [sender] });
        break;
      }

      case 'alwaysonline': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          if (settings.get(sessionId, 'bot', 'alwaysonline', false)) return reply('Always Online is already ON.');
          settings.set(sessionId, 'bot', 'alwaysonline', true);
          try { await sock.sendPresenceUpdate('available'); } catch (e) {}
          await reply('🟢 Always-online presence *enabled*.');
        } else if (opt === 'off') {
          if (!settings.get(sessionId, 'bot', 'alwaysonline', false)) return reply('Always Online is already OFF.');
          settings.set(sessionId, 'bot', 'alwaysonline', false);
          await reply('🟢 Always-online presence disabled.');
        } else {
          await reply(`Usage: ${prefix}alwaysonline\nCurrent: ${settings.get(sessionId,'bot','alwaysonline',false)?'ON':'OFF'}`);
        }
        break;
      }

      case 'rejectcall': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          if (settings.get(sessionId, 'bot', 'rejectcall', false)) return reply('Auto Reject Calls is already ON.');
          settings.set(sessionId, 'bot', 'rejectcall', true);
          await reply('📞 Auto-reject calls *enabled*.');
        } else if (opt === 'off') {
          if (!settings.get(sessionId, 'bot', 'rejectcall', false)) return reply('Auto Reject Calls is already OFF.');
          settings.set(sessionId, 'bot', 'rejectcall', false);
          await reply('📞 Auto-reject calls disabled.');
        } else {
          await reply(`Usage: ${prefix}rejectcall\nCurrent: ${settings.get(sessionId,'bot','rejectcall',false)?'ON':'OFF'}`);
        }
        break;
      }

      case 'antidelete': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          if (settings.get(sessionId, 'bot', 'antidelete', false)) return reply('Anti-Delete is already ON.');
          settings.set(sessionId, 'bot', 'antidelete', true);
          await reply('Anti-Delete is ON.');
        } else if (opt === 'off') {
          if (!settings.get(sessionId, 'bot', 'antidelete', false)) return reply('Anti-Delete is already OFF.');
          settings.set(sessionId, 'bot', 'antidelete', false);
          await reply('Anti-Delete is OFF.');
        } else if (opt === 'chat' || opt === 'dm' || opt === 'owner') {
          const dest = opt === 'chat' ? 'chat' : 'owner';
          settings.set(sessionId, 'bot', 'antidelete', true);
          settings.set(sessionId, 'bot', 'antideleteDest', dest);
          await reply(dest === 'chat'
            ? '✅ Anti-Delete is ON — deleted messages will be resent in the *same chat*.'
            : '✅ Anti-Delete is ON — deleted messages will be sent to your *private DM*.');
        } else {
          const on = settings.get(sessionId, 'bot', 'antidelete', false);
          const dest = settings.get(sessionId, 'bot', 'antideleteDest', 'owner');
          await reply(
            `Usage: ${prefix}antidelete <on|off|chat|dm>\n` +
            `• on/off — toggle the feature\n` +
            `• chat — resend deleted messages in the same chat\n` +
            `• dm — send deleted messages to your private DM\n\n` +
            `Current: ${on ? 'ON' : 'OFF'} (destination: ${dest === 'chat' ? 'same chat' : 'your DM'})`
          );
        }
        break;
      }

      case 'antiedit': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          if (settings.get(sessionId, 'bot', 'antiedit', false)) return reply('Anti-Edit is already ON.');
          settings.set(sessionId, 'bot', 'antiedit', true);
          await reply('Anti-Edit is ON.');
        } else if (opt === 'off') {
          if (!settings.get(sessionId, 'bot', 'antiedit', false)) return reply('Anti-Edit is already OFF.');
          settings.set(sessionId, 'bot', 'antiedit', false);
          await reply('Anti-Edit is OFF.');
        } else if (opt === 'chat' || opt === 'dm' || opt === 'owner') {
          const dest = opt === 'chat' ? 'chat' : 'owner';
          settings.set(sessionId, 'bot', 'antiedit', true);
          settings.set(sessionId, 'bot', 'antieditDest', dest);
          await reply(dest === 'chat'
            ? '✅ Anti-Edit is ON — edited messages will be shown in the *same chat*.'
            : '✅ Anti-Edit is ON — edited messages will be sent to your *private DM*.');
        } else {
          const on = settings.get(sessionId, 'bot', 'antiedit', false);
          const dest = settings.get(sessionId, 'bot', 'antieditDest', 'owner');
          await reply(
            `Usage: ${prefix}antiedit <on|off|chat|dm>\n` +
            `• on/off — toggle the feature\n` +
            `• chat — show edits in the same chat\n` +
            `• dm — send edits to your private DM\n\n` +
            `Current: ${on ? 'ON' : 'OFF'} (destination: ${dest === 'chat' ? 'same chat' : 'your DM'})`
          );
        }
        break;
      }

      case 'getsudo': {
        if (!isOwner && !isModUser && !isSudoUser) return reply(config.MESSAGES.onlySudo);
        const list = db.getSudoList(sessionId) || [];
        if (!list.length) return reply('❖ 𝙅𝙄𝙉𝙓 𝙆9 SUDO\nCount: *0*\n_Empty_');
        const seen = new Set();
        const lines = [];
        const mentions = [];
        for (const j of list) {
          const resolved = await resolvePhoneJid(sock, j, participants) || j;
          const phone = String(resolved).replace(/[^0-9]/g, '');
          const key = phone || String(resolved);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const tag = phone || String(resolved).split('@')[0];
          lines.push(`❑ @${tag}`);
          mentions.push(resolved);
        }
        if (!lines.length) return reply('❖ 𝙅𝙄𝙉𝙓 𝙆9 SUDO\n_Empty_');
        await reply(`❖ 𝙅𝙄𝙉𝙓 𝙆9 SUDO\nCount: *${lines.length}*\n\n${lines.join('\n')}`, { mentions });
        break;
      }

      case 'getmod': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const list = db.getModList(sessionId) || [];
        if (!list.length) return reply('❖ 𝙅𝙄𝙉𝙓 𝙆9 MODS\nCount: *0*\n_Empty_');
        const seen = new Set();
        const lines = [];
        const mentions = [];
        for (const j of list) {
          const resolved = await resolvePhoneJid(sock, j, participants) || j;
          const phone = String(resolved).replace(/[^0-9]/g, '');
          const key = phone || String(resolved);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const tag = phone || String(resolved).split('@')[0];
          lines.push(`❑ @${tag}`);
          mentions.push(resolved);
        }
        if (!lines.length) return reply('❖ 𝙅𝙄𝙉𝙓 𝙆9 MODS\n_Empty_');
        await reply(`❖ 𝙅𝙄𝙉𝙓 𝙆9 MODS\nCount: *${lines.length}*\n\n${lines.join('\n')}`, { mentions });
        break;
      }

      // ---------- STICKER COMMANDS ----------
      case 'setcmd': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const ctx = m.message?.extendedTextMessage?.contextInfo || {};
        const quoted = ctx.quotedMessage;
        if (!quoted?.stickerMessage) return reply(`Reply to a sticker:\n${prefix}setcmd kick`);
        if (!q) return reply(`Example: ${prefix}setcmd kick`);
        const sha = quoted.stickerMessage.fileSha256;
        if (!sha) return reply('Could not read sticker hash.');
        const hash = Buffer.isBuffer(sha) ? sha.toString('hex') : Buffer.from(sha).toString('hex');
        const map = settings.get(sessionId, 'bot', 'stickerCmds', {}) || {};
        const cmdText = q.trim().replace(new RegExp('^\\' + prefix), '');
        map[hash] = cmdText;
        settings.set(sessionId, 'bot', 'stickerCmds', map);
        await reply(`✅ Sticker bound to *${prefix}${cmdText.split(/\s+/)[0]}*\nReply to someone with that sticker to run it.`);
        break;
      }

      case 'delcmd': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const ctx = m.message?.extendedTextMessage?.contextInfo || {};
        const quoted = ctx.quotedMessage;
        if (!quoted?.stickerMessage) return reply(`Reply to a sticker: ${prefix}delcmd`);
        const sha = quoted.stickerMessage.fileSha256;
        if (!sha) return reply('Could not read sticker hash.');
        const hash = Buffer.isBuffer(sha) ? sha.toString('hex') : Buffer.from(sha).toString('hex');
        const map = settings.get(sessionId, 'bot', 'stickerCmds', {}) || {};
        if (!map[hash]) return reply('No command bound to this sticker.');
        const old = map[hash];
        delete map[hash];
        settings.set(sessionId, 'bot', 'stickerCmds', map);
        await reply(`✅ Removed sticker command: *${old}*`);
        break;
      }

      case 'listcmd': {
        const map = settings.get(sessionId, 'bot', 'stickerCmds', {}) || {};
        const entries = Object.entries(map);
        if (!entries.length) return reply('No sticker commands set.');
        let t = '*Sticker Commands*\n\n';
        entries.forEach(([h, c], i) => { t += `${i + 1}. ${prefix}${c} \`(hash ${h.slice(0, 8)}…)\`\n`; });
        await reply(t);
        break;
      }

      // ---------- APK / APP ----------
      case 'apk': {
        if (!q) return reply(`Example: ${prefix}app WhatsApp`);
        try {
          await reply(`🔍 Searching APK: *${q}*…`);
          const endpoint = `https://ws75.aptoide.com/api/7/apps/search/query=${encodeURIComponent(q)}/limit=5`;
          const { data } = await axios.get(endpoint, { timeout: 30000, headers: { 'User-Agent': 'Jinx-K9-MD/8.1' } });
          const list = data?.datalist?.list || [];
          if (!list.length) return reply('❌ App not found. Try a more exact name.');
          const app = list.find(x => x?.file?.path) || list[0];
          const downloadUrl = app?.file?.path || app?.file?.path_alt;
          if (!downloadUrl) return reply('❌ This app has no downloadable APK listed.');
          // WhatsApp documents can be up to 2 GB. Stream the APK directly from the
          // source URL instead of buffering it in Node or enforcing the old 100 MB limit.
          const size = Number(app?.file?.filesize || app?.size || 0);
          if (size > 2 * 1024 * 1024 * 1024) return reply('❌ This APK is larger than WhatsApp\'s 2GB document limit.');
          await sock.sendMessage(from, {
            document: { url: downloadUrl },
            mimetype: 'application/vnd.android.package-archive',
            fileName: `${String(app.name || 'app').replace(/[^a-z0-9._-]+/gi, '_')}.apk`,
            caption: `📦 *${app.name || 'App'}*
Package: ${app.package || '-'}
Version: ${app.file?.vername || '-'}
Source: Aptoide`
          }, { quoted: m });
        } catch (e) {
          console.error('app/apk error:', e.response?.data || e.message);
          await reply('❌ App/APK download failed. The app store may be unavailable or this app may not have a downloadable APK.');
        }
        break;
      }

      // ---------- GC STATUS (groupStatusMessageV2 + relay) ----------
      case 'gcstatus': {
        if (!isOwner && !isModUser && !isSudoUser) return reply('Only owner/mod/sudo.');
        try {
          const baileys = await getBaileys();
          const {
            prepareWAMessageMedia,
            generateWAMessageFromContent,
            proto,
            downloadContentFromMessage
          } = baileys;

          const COLORS = {
            green:  0xFF25D366,
            red:    0xFFFF0000,
            blue:   0xFF0000FF,
            yellow: 0xFFFFFF00,
            purple: 0xFF800080,
            black:  0xFF000000,
            white:  0xFFFFFFFF,
            orange: 0xFFFFA500
          };

          const ctx = m.message?.extendedTextMessage?.contextInfo || {};
          const quoted = ctx.quotedMessage;
          let groupId = isGroup ? from : null;
          let messageText = q || '';
          let chosenColor = null;

          // From DM: .gcstatus groupjid,text,color  OR reply media + groupjid
          if (!isGroup) {
            if (quoted) {
              // need group JID as first arg
              const parts = (q || '').split(',').map(p => p.trim()).filter(Boolean);
              groupId = parts[0] || (args[0] && args[0].includes('@g.us') ? args[0] : null);
              if (!groupId) return reply(`Provide the group JID.\nUsage: ${prefix}gcstatus 123456789-123@g.us\n(while replying to media)`);
            } else {
              const parts = (q || '').split(',').map(p => p.trim());
              if (parts.length < 2) {
                return reply(`Usage: ${prefix}gcstatus groupjid,message,color\nExample: ${prefix}gcstatus 123456789-123@g.us,Hello!,blue\nColors: ${Object.keys(COLORS).join(', ')}`);
              }
              groupId = parts[0];
              messageText = parts[1] || '';
              if (parts[2] && COLORS[parts[2].toLowerCase()]) chosenColor = COLORS[parts[2].toLowerCase()];
            }
          } else {
            // In group: optional color at end of text  .gcstatus Hello,red
            if (messageText.includes(',')) {
              const parts = messageText.split(',').map(p => p.trim());
              const maybeColor = parts[parts.length - 1].toLowerCase();
              if (COLORS[maybeColor]) {
                chosenColor = COLORS[maybeColor];
                messageText = parts.slice(0, -1).join(',').trim();
              }
            }
          }

          if (!groupId) return reply(`Use in the group: ${prefix}gcstatus Hello\nOr reply to media with ${prefix}gcstatus`);

          if (!quoted && !String(messageText || '').trim()) {
            return reply(
              `Reply to media or provide text\n\n` +
              `Examples:\n` +
              `${prefix}gcstatus Hello Group\n` +
              `${prefix}gcstatus Hello Group,red\n` +
              `Colors: green, red, blue, yellow, purple, black, white, orange\n\n` +
              `From DM: ${prefix}gcstatus groupjid,Hello!,blue`
            );
          }

          let messagePayload = null;

          if (quoted) {
            const mediaMsg =
              quoted.viewOnceMessage?.message ||
              quoted.viewOnceMessageV2?.message ||
              quoted.viewOnceMessageV2Extension?.message ||
              quoted;
            const type = Object.keys(mediaMsg || {}).find(k =>
              ['imageMessage', 'videoMessage', 'audioMessage'].includes(k)
            );
            if (!type) return reply('Reply to an image, video or audio.');

            const stream = await downloadContentFromMessage(mediaMsg[type], type.replace('Message', ''));
            const buffer = await collectMediaWithLimit(stream, 200 * 1024 * 1024, 'group-status media');
            if (!buffer?.length) throw new Error('Media download was empty');

            let mediaOptions = {};
            if (type === 'imageMessage') {
              mediaOptions = { image: buffer, caption: messageText || mediaMsg[type]?.caption || '' };
            } else if (type === 'videoMessage') {
              mediaOptions = { video: buffer, caption: messageText || mediaMsg[type]?.caption || '' };
            } else {
              mediaOptions = {
                audio: buffer,
                mimetype: mediaMsg[type]?.mimetype || 'audio/ogg; codecs=opus',
                ptt: true
              };
            }

            const prepared = await prepareWAMessageMedia(mediaOptions, {
              upload: sock.waUploadToServer
            });

            let mediaMessage = {};
            if (type === 'imageMessage') mediaMessage = { imageMessage: prepared.imageMessage };
            else if (type === 'videoMessage') mediaMessage = { videoMessage: prepared.videoMessage };
            else mediaMessage = { audioMessage: prepared.audioMessage };

            messagePayload = {
              groupStatusMessageV2: { message: mediaMessage }
            };
          } else {
            if (!messageText) {
              return reply(`Reply to media or provide text:\n${prefix}gcstatus Hello\n${prefix}gcstatus Hello,blue`);
            }
            let bgColor = chosenColor ?? (() => {
              const randomHex = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
              return 0xff000000 + parseInt(randomHex, 16);
            })();

            messagePayload = {
              groupStatusMessageV2: {
                message: {
                  extendedTextMessage: {
                    text: messageText,
                    backgroundArgb: bgColor,
                    font: 2
                  }
                }
              }
            };
          }

          const msg = generateWAMessageFromContent(
            groupId,
            proto.Message.fromObject(messagePayload),
            { userJid: sock.user?.id }
          );

          await sock.relayMessage(groupId, msg.message, { messageId: msg.key.id });
          await reply('✅ Posted to Group Status.');
        } catch (e) {
          console.error('gcstatus:', e);
          await reply(`❌ Group Status failed: ${e.message || 'unsupported by this WhatsApp/Baileys build'}`);
        }
        break;
      }


      // ---------- REPORT TO WHATSAPP ----------
      case 'report': {
        if (!isOwner && !isModUser && !isSudoUser && !(isGroup && isAdmin)) {
          return reply('Only owner, mod, sudo, or a group admin can use report.');
        }

        let target = getTargetJids(m, args)[0];
        if (!target) {
          const ctx = m.message?.extendedTextMessage?.contextInfo || {};
          if (ctx.participant) target = ctx.participant;
        }
        if (!target && !isGroup && from && !from.endsWith('@g.us')) target = from;
        if (!target) {
          return reply(
            `📢 *Report*\nReply or tag + reason:\n` +
            `• ${prefix}report @user spam links\n` +
            `• (reply) ${prefix}report harassment\n` +
            `• ${prefix}report @user | scam | block`
          );
        }

        const targetNum = String(target).replace(/[^0-9]/g, '');
        if (targetNum && botNumber && targetNum === botNumber) return reply('Cannot report the bot.');

        let rawQ = String(q || '').trim();
        const alsoBlock = /\bblock\b/i.test(rawQ);
        let reason = '';
        if (rawQ.includes('|')) {
          reason = rawQ.split('|').map(s => s.trim())
            .filter(p => p && !/^block$/i.test(p) && !/^@?\d+$/.test(p.replace(/\s/g, '')))
            .map(p => p.replace(/@\d+/g, '').replace(/\bblock\b/gi, '').trim())
            .filter(Boolean).join(' — ');
        } else {
          reason = rawQ.replace(/@\d+/g, ' ').replace(/\bblock\b/gi, ' ').replace(/\s+/g, ' ').trim();
        }
        reason = reason.slice(0, 500);
        if (!reason || reason.length < 3) {
          return reply(`Add why you are reporting.\nExample: ${prefix}report @user spam ads`);
        }

        try {
          const { reportViaSocket } = require('./services/wa-report');
          const r = await reportViaSocket(sock, target, reason);
          let blockNote = '';
          if (alsoBlock) {
            try {
              await sock.updateBlockStatus(r.jid || target, 'block');
              blockNote = '\n🚫 Also *blocked*.';
            } catch (e) {
              blockNote = '\n⚠️ Block failed: ' + (e.message || 'error');
            }
          }

          let body = r.ok
            ? `✅ *Report packet SENT*\nMethod: *${r.method}*\n`
            : `❌ *Report NOT accepted by WhatsApp/Baileys*\n`;
          body += `User: ${r.jid}\nReason: ${reason}\n━━━━━━━━━━━━\n*Attempts:*\n`;
          for (const a of (r.attempts || [])) {
            body += `${a.ok ? '✓' : '✗'} ${a.method}: ${String(a.detail || '').slice(0, 100)}\n`;
          }
          body += blockNote;
          if (!r.ok) body += `\n_Use official app: chat → ⋮ → Report_`;
          await reply(body);
        } catch (e) {
          console.error('report error:', e);
          await reply(`❌ Report failed: ${e.message || e}`);
        }
        break;
      }



      // ---------- BLOCK / UNBLOCK ----------
      case 'block': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        let target = getTargetJids(m, args)[0];
        if (!target && !isGroup) target = from;
        if (!target) return reply('Tag/reply or use in their DM: ' + prefix + 'block');
        try {
          const candidates = [];
          const n = String(target).replace(/[^0-9]/g, '');
          candidates.push(String(target));
          if (n) {
            candidates.push(n + '@s.whatsapp.net');
            candidates.push(n + '@c.us');
          }
          // Resolve via onWhatsApp when possible
          try {
            const ow = await sock.onWhatsApp(n ? n + '@s.whatsapp.net' : target);
            const hit = Array.isArray(ow) ? ow[0] : ow;
            if (hit?.jid) candidates.unshift(hit.jid);
          } catch (e) {}
          let ok = false;
          let lastErr = '';
          const tried = new Set();
          for (const j of candidates) {
            if (!j || tried.has(j)) continue;
            tried.add(j);
            try {
              await sock.updateBlockStatus(j, 'block');
              ok = true;
              target = j;
              break;
            } catch (e) {
              lastErr = e.message || String(e);
            }
          }
          if (ok) await reply('🚫 Blocked @' + String(target).split('@')[0], { mentions: [target] });
          else await reply('❌ Block failed: ' + lastErr);
        } catch (e) {
          await reply('❌ Block failed: ' + (e.message || ''));
        }
        break;
      }

      case 'unblock': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        let target = getTargetJids(m, args)[0];
        if (!target && !isGroup) target = from;
        if (!target) return reply('Tag/reply: ' + prefix + 'unblock');
        try {
          const candidates = [];
          const n = String(target).replace(/[^0-9]/g, '');
          candidates.push(String(target));
          if (n) {
            candidates.push(n + '@s.whatsapp.net');
            candidates.push(n + '@c.us');
          }
          try {
            const ow = await sock.onWhatsApp(n ? n + '@s.whatsapp.net' : target);
            const hit = Array.isArray(ow) ? ow[0] : ow;
            if (hit?.jid) candidates.unshift(hit.jid);
          } catch (e) {}
          let ok = false;
          let lastErr = '';
          const tried = new Set();
          for (const j of candidates) {
            if (!j || tried.has(j)) continue;
            tried.add(j);
            try {
              await sock.updateBlockStatus(j, 'unblock');
              ok = true;
              target = j;
              break;
            } catch (e) {
              lastErr = e.message || String(e);
            }
          }
          if (ok) await reply('✅ Unblocked @' + String(target).split('@')[0], { mentions: [target] });
          else await reply('❌ Unblock failed: ' + lastErr);
        } catch (e) {
          await reply('❌ Unblock failed.');
        }
        break;
      }
      // ---------- GET PP ----------
      case 'getpp': {
        let target = getTargetJids(m, args)[0] || (isGroup ? sender : from);
        try {
          const url = await sock.profilePictureUrl(target, 'image').catch(() => null);
          if (!url) return reply('❌ No profile picture / privacy blocked.');
          await sock.sendMessage(from, { image: { url }, caption: `📷 PP @${String(target).split('@')[0]}` }, { quoted: m });
        } catch (e) {
          await reply('❌ Could not fetch profile picture.');
        }
        break;
      }

      // ---------- CLEAR (delete quoted / bot messages note) ----------
      case 'clear': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const n = Math.min(parseInt(args[0], 10) || 0, 100);

        if (n > 0) {
          // Safer path: actually revoke the last N messages we've seen in
          // this chat, one by one. This is a real per-message delete, not
          // the app-state "chatModify" patch below — it doesn't depend on
          // WhatsApp's app-state sync working correctly, so it's far more
          // reliable (and can't trigger the multi-device logout that a
          // malformed chatModify call is known to cause).
          try {
            const pairMod = require('./pair');
            const cache = pairMod.messageCache?.get(sessionId);
            const inChat = cache
              ? [...cache.values()].filter(c => c.key?.remoteJid === from).sort((a, b) => b.ts - a.ts).slice(0, n)
              : [];
            if (!inChat.length) return reply('No cached messages for this chat yet — try again after a few messages have come through, or use `.clear` with no number.');
            let deleted = 0;
            for (const c of inChat) {
              try {
                await sock.sendMessage(from, { delete: c.key });
                deleted++;
              } catch (e) {}
            }
            await reply(`🧹 Deleted ${deleted}/${inChat.length} recent message(s) in this chat.`);
          } catch (e) {
            await reply(`❌ Clear failed: ${e.message}`);
          }
          break;
        }

        // No-argument form: ask WhatsApp to clear this chat on this account
        // via the app-state chatModify call. Heads up — this specific call
        // is known to be unreliable across Baileys builds (it can silently
        // no-op, and a malformed payload can even log out all linked
        // devices), and Baileys uses this exact same call, so there is not a
        // "more correct" version of it to copy — use `.clear 20` above for
        // something that reliably works instead.
        try {
          if (typeof sock.chatModify === 'function') {
            await sock.chatModify({ delete: true, lastMessages: [{ key: m.key, messageTimestamp: m.messageTimestamp }] }, from);
          }
          await reply(`🧹 Clear requested for this chat (device-side).\n_Tip: ${prefix}clear 20 deletes your last 20 seen messages directly and more reliably._`);
        } catch (e) {
          await reply(`❌ Clear not supported on this session. Try ${prefix}clear 20 instead.`);
        }
        break;
      }

      // ---------- GROUP MUTE TIMER ----------
      case 'mute': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        const timeArg = (args[0] || '').toLowerCase();

        // Reuse the groupMetadata already fetched a moment ago for this
        // message (handler preamble) instead of firing a second live
        // groupMetadata call here. That second call was an extra network
        // round trip that could intermittently time out / fail on its own,
        // which is what made unmute silently no-op until you ran mute again.
        // Only fall back to a fresh fetch if the preamble fetch itself
        // came back empty (e.g. it hit its own timeout).
        let liveMeta = groupMetadata;
        if (!liveMeta?.id) {
          liveMeta = await getGroupMetadataCached(sock, sessionId, from, true);
          if (!liveMeta) return reply('❌ Could not check the group settings. Try again.');
        }
        const liveMuted = liveMeta?.announce === true;
        if (liveMuted) {
          settings.set(sessionId, from, 'groupMuted', true);
          return reply('Group is already muted.');
        }
        try {
          await sock.groupSettingUpdate(from, 'announcement');
          invalidateGroupMetadata(sessionId, from, { ...liveMeta, announce: true });
        } catch (e) {
          return reply('❌ Failed to mute the group — WhatsApp rejected the request. Try again.');
        }
        if (!timeArg) {
          settings.set(sessionId, from, 'groupMuted', true);
          settings.set(sessionId, from, 'groupMuteUntil', 0);
          await reply('🔇 Group muted successfully.');
          break;
        }
        let ms = 0;
        const n = parseInt(timeArg, 10);
        if (timeArg.endsWith('s')) ms = n * 1000;
        else if (timeArg.endsWith('m')) ms = n * 60 * 1000;
        else if (timeArg.endsWith('h')) ms = n * 60 * 60 * 1000;
        else if (timeArg.endsWith('d')) ms = n * 24 * 60 * 60 * 1000;
        else ms = n * 60 * 1000;
        if (ms > 0) {
          const until = Date.now() + ms;
          settings.set(sessionId, from, 'groupMuted', true);
          settings.set(sessionId, from, 'groupMuteUntil', until);
          const mins = Math.max(1, Math.round(ms / 60000));
          await reply(`Group is muted for ${mins} min.`);
          setTimeout(async () => {
            try {
              const u = settings.get(sessionId, from, 'groupMuteUntil', 0);
              if (u && Date.now() >= u - 1000) {
                const meta = await getGroupMetadataCached(sock, sessionId, from, true);
                if (meta?.announce === true) {
                  await sock.groupSettingUpdate(from, 'not_announcement');
                  invalidateGroupMetadata(sessionId, from, { ...meta, announce: false });
                  await sock.sendMessage(from, { text: responseAction('unmute', 'Group unmuted successfully.') });
                }
                settings.set(sessionId, from, 'groupMuteUntil', 0);
                settings.set(sessionId, from, 'groupMuted', false);
              }
            } catch (e) {}
          }, ms);
        } else {
          settings.set(sessionId, from, 'groupMuted', true);
          settings.set(sessionId, from, 'groupMuteUntil', 0);
          await reply('🔇 Group muted successfully.');
        }
        break;
      }

      case 'unmute': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isBotAdmin) return reply('⚠️ The bot must be a group admin to perform this action.');
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');

        // Same reasoning as .mute above: trust the metadata already fetched
        // for this message rather than making another live call here,
        // unless that fetch itself came back empty.
        let liveMeta = groupMetadata;
        if (!liveMeta?.id) {
          liveMeta = await getGroupMetadataCached(sock, sessionId, from, true);
          if (!liveMeta) return reply('❌ Could not check the group settings. Try again.');
        }
        const liveMuted = liveMeta?.announce === true;
        if (!liveMuted) {
          settings.set(sessionId, from, 'groupMuted', false);
          settings.set(sessionId, from, 'groupMuteUntil', 0);
          return reply('Group is already unmuted.');
        }
        try {
          await sock.groupSettingUpdate(from, 'not_announcement');
          invalidateGroupMetadata(sessionId, from, { ...liveMeta, announce: false });
        } catch (e) {
          return reply('❌ Failed to unmute the group — WhatsApp rejected the request. Try again.');
        }
        settings.set(sessionId, from, 'groupMuteUntil', 0);
        settings.set(sessionId, from, 'groupMuted', false);
        await reply('🔊 Group unmuted successfully.');
        break;
      }

      // ---------- AUTO STATUS VIEW / REACT ----------
      case 'autostatus': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          settings.set(sessionId, 'bot', 'autostatus', true);
          await reply('✅ Auto status view *ON*');
        } else if (opt === 'off') {
          settings.set(sessionId, 'bot', 'autostatus', false);
          await reply('✅ Auto status view *OFF*');
        } else {
          await reply(`Usage: ${prefix}autostatus on/off\nCurrent: ${settings.get(sessionId,'bot','autostatus',false)?'ON':'OFF'}`);
        }
        break;
      }

      case 'statusreact': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          settings.set(sessionId, 'bot', 'statusreact', true);
          await reply('✅ Status auto-react *ON* — a random reaction will be used for each status.');
        } else if (opt === 'off') {
          settings.set(sessionId, 'bot', 'statusreact', false);
          await reply('✅ Status auto-react *OFF*');
        } else {
          await reply(`Usage: ${prefix}statusreact on\n${prefix}statusreact off`);
        }
        break;
      }

      case 'statussave': {
        // Toggle auto-save of contact statuses (owner/mod only).
        // Note: .savestatus is a different command — reply to a status to save it once.
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const opt = (args[0] || '').toLowerCase();
        if (opt === 'on') {
          settings.set(sessionId, 'bot', 'statussave', true);
          await reply('✅ Status auto-save *ON* — statuses from your contacts will be forwarded to your DM.');
        } else if (opt === 'off') {
          settings.set(sessionId, 'bot', 'statussave', false);
          await reply('✅ Status auto-save *OFF*');
        } else {
          await reply(
            `Usage: ${prefix}statussave on/off\n` +
            `Current: ${settings.get(sessionId,'bot','statussave',false) ? 'ON' : 'OFF'}\n\n` +
            `This is independent of ${prefix}autostatus (view) and ${prefix}statusreact (like) — turn on any combination you want.\n` +
            `To save one status manually: reply to it with ${prefix}savestatus`
          );
        }
        break;
      }

      // ---------- FILTERS (auto-reply) ----------
      case 'pfilter': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        // pfilter trigger | response
        if (!q.includes('|')) {
          const filters = settings.get(sessionId, 'bot', 'pfilters', {}) || {};
          const keys = Object.keys(filters);
          if (!keys.length) return reply(`Usage: ${prefix}pfilter hello | Hi there!\n${prefix}pstop hello`);
          return reply('*PM Filters*\n' + keys.map((k, i) => `${i + 1}. ${k} → ${filters[k]}`).join('\n'));
        }
        const [trig, ...rest] = q.split('|');
        const filters = settings.get(sessionId, 'bot', 'pfilters', {}) || {};
        filters[trig.trim().toLowerCase()] = rest.join('|').trim();
        settings.set(sessionId, 'bot', 'pfilters', filters);
        await reply(`✅ PM filter set:\n*${trig.trim()}* → ${rest.join('|').trim()}`);
        break;
      }

      case 'pstop': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const filters = settings.get(sessionId, 'bot', 'pfilters', {}) || {};
        const key = (q || '').trim().toLowerCase();
        if (!key || !filters[key]) return reply('Filter not found.');
        delete filters[key];
        settings.set(sessionId, 'bot', 'pfilters', filters);
        await reply(`✅ Removed PM filter: ${key}`);
        break;
      }

      case 'gfilter': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!q.includes('|')) {
          const filters = settings.get(sessionId, from, 'gfilters', {}) || {};
          const keys = Object.keys(filters);
          if (!keys.length) return reply(`Usage: ${prefix}gfilter hi | Hello!\n${prefix}gstop hi`);
          return reply('*Group Filters*\n' + keys.map((k, i) => `${i + 1}. ${k} → ${filters[k]}`).join('\n'));
        }
        const [trig, ...rest] = q.split('|');
        const filters = settings.get(sessionId, from, 'gfilters', {}) || {};
        filters[trig.trim().toLowerCase()] = rest.join('|').trim();
        settings.set(sessionId, from, 'gfilters', filters);
        await reply(`✅ Group filter set:\n*${trig.trim()}* → ${rest.join('|').trim()}`);
        break;
      }

      case 'gstop': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        const filters = settings.get(sessionId, from, 'gfilters', {}) || {};
        const key = (q || '').trim().toLowerCase();
        if (!key || !filters[key]) return reply('Filter not found.');
        delete filters[key];
        settings.set(sessionId, from, 'gfilters', filters);
        await reply(`✅ Removed group filter: ${key}`);
        break;
      }

      // ---------- MP4 → MP3 ----------
      case 'mp3': {
        const ctx = m.message?.extendedTextMessage?.contextInfo || {};
        const quoted = ctx.quotedMessage;
        if (!quoted?.videoMessage && !quoted?.audioMessage && !msg.videoMessage) {
          return reply(`Reply to a video: ${prefix}mp3`);
        }
        try {
          const mediaMsg = quoted || msg;
          const type = mediaMsg.videoMessage ? 'videoMessage' : 'audioMessage';
          const { downloadContentFromMessage } = await getBaileys();
          const stream = await downloadContentFromMessage(mediaMsg[type], type.replace('Message', ''));
          let buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
          const fs = require('fs');
          const path = require('path');
          const os = require('os');
          const inFile = path.join(os.tmpdir(), `matrix_${Date.now()}.mp4`);
          const outFile = path.join(os.tmpdir(), `matrix_${Date.now()}.mp3`);
          fs.writeFileSync(inFile, buffer);
          const ffmpegBin = (() => {
            try { return require('ffmpeg-static'); } catch (e) {}
            return 'ffmpeg';
          })();
          const { execFile } = require('child_process');
          await new Promise((resolve, reject) => {
            execFile(ffmpegBin, ['-y', '-i', inFile, '-vn', '-acodec', 'libmp3lame', '-ab', '128k', outFile], (err) => err ? reject(err) : resolve());
          });
          const audio = fs.readFileSync(outFile);
          await sock.sendMessage(from, { audio, mimetype: 'audio/mpeg', fileName: 'audio.mp3' }, { quoted: m });
          try { fs.unlinkSync(inFile); fs.unlinkSync(outFile); } catch (e) {}
        } catch (e) {
          console.error('mp3:', e.message);
          await reply('❌ Conversion failed (need ffmpeg).');
        }
        break;
      }

      // ---------- SAVE STATUS ----------
      case 'savestatus': {
        const ctx = m.message?.extendedTextMessage?.contextInfo || {};
        // status replies often have remoteJid status@broadcast
        const quoted = ctx.quotedMessage;
        if (!quoted) return reply(`Reply to a status with ${prefix}savestatus`);
        try {
          let mediaMsg =
            quoted.viewOnceMessage?.message ||
            quoted.viewOnceMessageV2?.message ||
            quoted;
          const type = Object.keys(mediaMsg || {}).find((k) =>
            ['imageMessage', 'videoMessage', 'audioMessage'].includes(k)
          );
          const dest = botJid || (botNumber + '@s.whatsapp.net');
          if (!type) {
            const t = quoted.conversation || quoted.extendedTextMessage?.text;
            if (t) await sock.sendMessage(dest, { text: `📌 Status:\n${t}` });
            else return reply('Unsupported status type.');
            await reply('✅ Status text saved to your DM.');
            break;
          }
          const { downloadContentFromMessage } = await getBaileys();
          const stream = await downloadContentFromMessage(mediaMsg[type], type.replace('Message', ''));
          let buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
          const payload = {};
          if (type === 'imageMessage') payload.image = buffer;
          else if (type === 'videoMessage') payload.video = buffer;
          else payload.audio = buffer;
          payload.caption = mediaMsg[type]?.caption || '📌 Saved status';
          await sock.sendMessage(dest, payload);
          await reply('✅ Status saved to your DM.');
        } catch (e) {
          console.error('savestatus:', e.message);
          await reply('❌ Failed to save status.');
        }
        break;
      }



      // ---------- CHECK NUMBER (on WhatsApp?) ----------
      case 'check': {
        try {
          let target = null;
          // 1) tag / reply
          const tagged = getTargetJids(m, args)[0];
          if (tagged) target = tagged;
          // 2) typed number
          if (!target && q) {
            let n = String(q).replace(/[\s\-()+]/g, '');
            if (n.startsWith('0')) n = n.replace(/^0+/, '');
            // if local NG style without country, keep as typed digits only
            if (!/^\d{8,15}$/.test(n)) {
              return reply('Usage:\n' + prefix + 'check 234xxxxxxxxxx\n' + prefix + 'check @user\n(or reply to someone)');
            }
            target = n + '@s.whatsapp.net';
          }
          if (!target) {
            return reply('Usage:\n' + prefix + 'check 234xxxxxxxxxx\n' + prefix + 'check @user\n(or reply to someone)');
          }
          const jid = String(target).includes('@') ? target : (String(target).replace(/\D/g, '') + '@s.whatsapp.net');
          const num = jid.replace(/@.+/, '').replace(/\D/g, '');
          // Baileys equivalent of whatsapp-web.js isRegisteredUser
          const results = await sock.onWhatsApp(jid).catch(() => null);
          const entry = Array.isArray(results) ? results[0] : results;
          const exists = !!(entry && (entry.exists === true || entry.jid));
          if (exists) {
            const realJid = entry.jid || jid;
            await reply(
              '✅ *On WhatsApp*\n\n' +
              'Number: `' + num + '`\n' +
              'JID: `' + realJid + '`\n\n' +
              '_Cannot detect temporary/permanent ban via API._'
            );
          } else {
            await reply(
              '❌ *Not on WhatsApp*\n\n' +
              'Number: `' + num + '`\n' +
              'This number is not registered on WhatsApp (or cannot be resolved).'
            );
          }
        } catch (e) {
          console.error('check:', e.message);
          await reply('❌ Could not check that number. Try again.');
        }
        break;
      }

      // ==================== FUN / ANIME REACTIONS ====================
      // Improved: force GIF->MP4 conversion and prefer animated video.
      case 'slap': {
        try {
          const action = command;
          const ctx = m.message?.extendedTextMessage?.contextInfo || {};
          const target = (ctx.mentionedJid || [])[0] || ctx.participant || null;

          const media = await fetchReactionMedia(action);
          let buffer = media.buffer;
          const contentType = String(media.contentType || '').toLowerCase();
          if (!buffer || buffer.length < 100) throw new Error('Reaction media was empty');

          const resolvedTarget = target
            ? (await resolvePhoneJid(sock, target, groupMetadata?.participants || participants || []) || target)
            : null;
          const resolvedSender = await resolvePhoneJid(sock, sender, groupMetadata?.participants || participants || []) || sender;
          const targetNum = resolvedTarget ? String(resolvedTarget).replace(/@.*/, '').replace(/\D/g, '') : '';
          const senderNumForCaption = String(resolvedSender).replace(/@.*/, '').replace(/\D/g, '') || senderNumber;
          const captions = {
            slap: 'slapped', hug: 'hugged', kiss: 'kissed', pat: 'patted',
            cuddle: 'cuddled with', tickle: 'tickled', feed: 'fed',
            smug: 'gave a smug look', meow: 'meowed at'
          };
          const verb = captions[action] || action;
          const noCaptionActions = ['neko', 'waifu', 'woof', 'goose', 'lizard', 'foxgirl', 'wallpaper', 'ngif'];
          const caption = targetNum
            ? `@${senderNumForCaption} ${verb} @${targetNum}`
            : (noCaptionActions.includes(action) ? '' : `${verb} ✨`);
          const mentions = [resolvedSender, resolvedTarget].filter(Boolean);

          // Detect media type
          const isGif = /gif/.test(contentType) || (buffer.length > 3 && buffer.subarray(0, 3).toString() === 'GIF');
          const isMp4 = /video\//.test(contentType) || /mp4/.test(contentType) ||
            (buffer.length > 12 && buffer.subarray(4, 8).toString() === 'ftyp');
          const isPng = /png/.test(contentType) || (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50);
          const isJpg = /jpe?g/.test(contentType) || (buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8);
          const isWebp = /webp/.test(contentType) ||
            (buffer.length > 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP');

          let sent = false;

          // Always try to convert GIF -> MP4 so WhatsApp shows animation
          let sendBuffer = buffer;
          let sendAsVideo = isMp4;
          if (isGif && !isMp4) {
            try {
              sendBuffer = await gifToMp4(buffer);
              sendAsVideo = sendBuffer && sendBuffer.length > 1000;
              if (!sendAsVideo) sendBuffer = buffer;
            } catch (convErr) {
              console.error(`${command} gifToMp4:`, convErr.message);
              sendBuffer = buffer;
              sendAsVideo = false;
            }
          }

          // 1) Preferred: animated video with gifPlayback
          if (sendAsVideo) {
            try {
              await sock.sendMessage(from, {
                video: sendBuffer,
                gifPlayback: true,
                mimetype: 'video/mp4',
                caption: caption || undefined,
                mentions: mentions.length ? mentions : undefined
              }, { quoted: m });
              sent = true;
            } catch (e) {
              console.error(`${command} video send:`, e.message);
            }
          }

          // 2) Direct image
          if (!sent && (isPng || isJpg || isWebp || /image\//.test(contentType))) {
            try {
              await sock.sendMessage(from, {
                image: buffer,
                caption: caption || undefined,
                mentions: mentions.length ? mentions : undefined
              }, { quoted: m });
              sent = true;
            } catch (e) {
              console.error(`${command} image send:`, e.message);
            }
          }

          // 3) Sticker fallback
          if (!sent) {
            try {
              const { Sticker, StickerTypes } = require('wa-sticker-formatter');
              const sticker = new Sticker(buffer, {
                pack: config.BOT_NAME,
                author: config.OWNER_NAME,
                type: StickerTypes?.FULL || 'full',
                quality: 75
              });
              const stickerBuffer = await sticker.toBuffer();
              if (stickerBuffer?.length > 100) {
                await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
                sent = true;
                if (caption) {
                  await sock.sendMessage(from, { text: caption, mentions }, { quoted: m }).catch(() => {});
                }
              }
            } catch (e) {
              console.error(`${command} sticker:`, e.message);
            }
          }

          // 4) Last resort: send GIF as document
          if (!sent && isGif) {
            try {
              await sock.sendMessage(from, {
                document: buffer,
                mimetype: 'image/gif',
                fileName: `${action}.gif`,
                caption: caption || undefined,
                mentions: mentions.length ? mentions : undefined
              }, { quoted: m });
              sent = true;
            } catch (e) {
              console.error(`${command} gif document:`, e.message);
            }
          }

          if (!sent) throw new Error('WhatsApp could not send the reaction media');
        } catch (e) {
          console.error(`${command}:`, e.message);
          await reply(`❌ ${command} failed: ${e.message || 'reaction provider unavailable'}`);
        }
        break;
      }


      // ==================== C: AUDIO EFFECTS ====================
      case 'bass': {
        try {
          const media = await downloadQuotedMedia(sock, m, ['audioMessage', 'videoMessage', 'documentMessage']);
          if (!media?.buffer?.length) return reply(`Reply to an audio/voice note with ${prefix}${command}`);
          const fx = AUDIO_FX[command] || AUDIO_FX.bass;
          const out = await processAudioEffect(media.buffer, command, fx);
          await sock.sendMessage(from, {
            audio: out,
            mimetype: 'audio/mpeg',
            ptt: false
          }, { quoted: m });
        } catch (e) {
          console.error(command, e.message);
          await reply(`❌ ${command} failed: ${e.message || 'ffmpeg error'}`);
        } finally {
        }
        break;
      }

      // ==================== G: CONVERTER TOOLS ====================
      case 'toimg': {
        try {
          const media = await downloadQuotedMedia(sock, m, ['stickerMessage', 'imageMessage']);
          if (!media?.buffer?.length) return reply(`Reply to a sticker with ${prefix}toimg`);
          await sock.sendMessage(from, { image: media.buffer, caption: '✅ Converted' }, { quoted: m });
        } catch (e) {
          await reply(`❌ Failed: ${e.message}`);
        }
        break;
      }

      case 'tomp4': {
        try {
          const media = await downloadQuotedMedia(sock, m, ['stickerMessage', 'videoMessage', 'imageMessage']);
          if (!media?.buffer?.length) return reply(`Reply to a sticker, image, or video with ${prefix}tomp4`);
          const contentType = String(media.contentType || '').toLowerCase();
          const isAlreadyVideo = /mp4|video\//.test(contentType) ||
            (media.buffer.length > 12 && media.buffer.subarray(4, 8).toString() === 'ftyp');
          const outBuffer = isAlreadyVideo ? media.buffer : await webpToMp4(media.buffer);
          await sock.sendMessage(from, { video: outBuffer, mimetype: 'video/mp4', caption: '✅ Converted to MP4' }, { quoted: m });
        } catch (e) {
          console.error('tomp4', e.message);
          await reply(`❌ Failed to convert: ${e.message || 'ffmpeg error'}. Make sure you replied to an animated sticker.`);
        } finally {
        }
        break;
      }

      case 'take': {
        try {
          const media = await downloadQuotedMedia(sock, m, ['stickerMessage', 'imageMessage', 'videoMessage']);
          if (!media?.buffer?.length) return reply(`Reply to a sticker/image with ${prefix}take Pack,Author`);
          let pack = config.BOT_NAME || '𝙅𝙄𝙉𝙓 𝙆9';
          let author = config.OWNER_NAME || 'PRIME';
          if (q && q.trim()) {
            const parts = q.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
            if (parts[0]) pack = parts[0];
            if (parts[1]) author = parts[1];
          }
          const { Sticker, StickerTypes } = require('wa-sticker-formatter');
          const sticker = new Sticker(media.buffer, {
            pack, author,
            type: StickerTypes?.FULL || 'full',
            quality: 75
          });
          const buf = await sticker.toBuffer();
          await sock.sendMessage(from, { sticker: buf }, { quoted: m });
        } catch (e) {
          await reply(`❌ take failed: ${e.message}`);
        }
        break;
      }

      case 'emojimix': {
        if (!q || !q.includes('+')) return reply(`Example: ${prefix}emojimix 😂+🔥`);
        try {
          const [e1, e2] = q.split('+').map(s => s.trim());
          if (!e1 || !e2) return reply(`Example: ${prefix}emojimix 😂+🔥`);
          const url = `https://tenor.googleapis.com/v2/featured?key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ&contentfilter=high&media_filter=png_transparent&component=proactive&collection=emoji_kitchen_v5&q=${encodeURIComponent(e1)}_${encodeURIComponent(e2)}`;
          // Fallback public emoji kitchen style
          const code1 = [...e1].map(c => c.codePointAt(0).toString(16)).join('-');
          const code2 = [...e2].map(c => c.codePointAt(0).toString(16)).join('-');
          const tries = [
            `https://api.fullhdwallpapers.xyz/api/emojimix?emoji1=${encodeURIComponent(e1)}&emoji2=${encodeURIComponent(e2)}`,
            `https://tenor.googleapis.com/v2/featured?key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ&q=${encodeURIComponent(e1)}_${encodeURIComponent(e2)}&collection=emoji_kitchen_v5&contentfilter=high`
          ];
          let imgBuf = null;
          for (const u of tries) {
            try {
              const { data } = await axios.get(u, { timeout: 20000, responseType: 'arraybuffer', headers: { 'User-Agent': 'JinxK9/1' }, validateStatus: s => s < 500 });
              if (Buffer.isBuffer(data) || data?.byteLength > 500) {
                // might be json
                const asText = Buffer.from(data).toString('utf8');
                if (asText.startsWith('{')) {
                  const j = JSON.parse(asText);
                  const link = j?.results?.[0]?.url || j?.results?.[0]?.media_formats?.png_transparent?.url || j?.url;
                  if (link) {
                    const r2 = await axios.get(link, { responseType: 'arraybuffer', timeout: 20000 });
                    imgBuf = Buffer.from(r2.data);
                    break;
                  }
                } else {
                  imgBuf = Buffer.from(data);
                  break;
                }
              }
            } catch (e) {}
          }
          // Direct Google emoji kitchen CDN pattern (best effort)
          if (!imgBuf) {
            const cdn = `https://www.gstatic.com/android/keyboard/emojikitchen/20201001/${code1}/${code1}_${code2}.png`;
            try {
              const r = await axios.get(cdn, { responseType: 'arraybuffer', timeout: 15000, validateStatus: s => s < 500 });
              if (r.status === 200 && r.data?.byteLength > 200) imgBuf = Buffer.from(r.data);
            } catch (e) {}
          }
          if (!imgBuf) return reply('❌ Could not mix those emojis. Try different ones.');
          const { Sticker, StickerTypes } = require('wa-sticker-formatter');
          const sticker = new Sticker(imgBuf, {
            pack: config.BOT_NAME,
            author: config.OWNER_NAME,
            type: StickerTypes?.FULL || 'full',
            quality: 80
          });
          await sock.sendMessage(from, { sticker: await sticker.toBuffer() }, { quoted: m });
        } catch (e) {
          await reply(`❌ emojimix failed: ${e.message}`);
        }
        break;
      }

      case 'hd': {
        try {
          const media = await downloadQuotedMedia(sock, m, ['imageMessage', 'stickerMessage']);
          if (!media?.buffer?.length) return reply(`Reply to an image with ${prefix}hd`);
          // Public upscale-style APIs (best effort)
          const FormData = require('form-data');
          let outBuf = null;
          try {
            const form = new FormData();
            form.append('image', media.buffer, { filename: 'image.jpg' });
            const { data } = await axios.post('https://api.siputzx.my.id/api/tools/remini', form, {
              headers: form.getHeaders(),
              timeout: 60000,
              responseType: 'arraybuffer',
              validateStatus: s => s < 500
            });
            if (data && data.byteLength > 500 && !Buffer.from(data).toString('utf8').startsWith('{')) {
              outBuf = Buffer.from(data);
            } else {
              const j = JSON.parse(Buffer.from(data).toString('utf8'));
              const link = j?.data || j?.result?.url || j?.url;
              if (link) {
                const r = await axios.get(link, { responseType: 'arraybuffer', timeout: 60000 });
                outBuf = Buffer.from(r.data);
              }
            }
          } catch (e) {}
          if (!outBuf) {
            // fallback: resend original
            outBuf = media.buffer;
            await reply('⚠️ HD API busy — sending original image.');
          }
          await sock.sendMessage(from, { image: outBuf, caption: '🖼️ HD' }, { quoted: m });
        } catch (e) {
          await reply(`❌ HD failed: ${e.message}`);
        } finally {
        }
        break;
      }

      case 'compress': {
        try {
          const media = await downloadQuotedMedia(sock, m, ['imageMessage', 'videoMessage', 'documentMessage']);
          if (!media?.buffer?.length) return reply(`Reply to media with ${prefix}compress`);
          if (media.type === 'imageMessage') {
            // compress image with ffmpeg quality
            const ffmpegPath = (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-cmp-'));
            const input = path.join(dir, 'in.jpg');
            const output = path.join(dir, 'out.jpg');
            fs.writeFileSync(input, media.buffer);
            await new Promise((resolve, reject) => {
              const child = require('child_process').spawn(ffmpegPath, ['-y', '-i', input, '-q:v', '8', output]);
              child.on('close', c => c === 0 ? resolve() : reject(new Error('compress failed')));
              child.on('error', reject);
            });
            const buf = fs.readFileSync(output);
            await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
            await sock.sendMessage(from, { image: buf, caption: `✅ Compressed (${media.buffer.length} → ${buf.length} bytes)` }, { quoted: m });
          } else {
            await reply('Compress currently supports images. Reply to a photo.');
          }
        } catch (e) {
          await reply(`❌ compress failed: ${e.message}`);
        } finally {
        }
        break;
      }

      // ==================== D: EXTRA DOWNLOADERS ====================
      case 'fb': {
        if (!q || !isUrl(q)) return reply(`Example: ${prefix}fb https://facebook.com/...`);
        try {
          const apis = [
            `https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(q)}`,
            `https://apis.davidcyriltech.my.id/facebook?url=${encodeURIComponent(q)}`
          ];
          let videoUrl = null, title = '';
          for (const api of apis) {
            try {
              const { data } = await axios.get(api, { timeout: 45000, headers: { 'User-Agent': 'Mozilla/5.0' } });
              videoUrl = data?.result?.url || data?.result?.video || data?.data?.url || data?.data?.video || data?.url || data?.video;
              title = data?.result?.title || data?.data?.title || '';
              if (videoUrl && String(videoUrl).startsWith('http')) break;
              videoUrl = null;
            } catch (e) {}
          }
          if (!videoUrl) return reply('❌ Facebook download failed. APIs may be down.');
          await sock.sendMessage(from, { video: { url: videoUrl }, caption: title || '✅ Facebook' }, { quoted: m });
        } catch (e) {
          await reply('❌ FB download failed.');
        } finally {
        }
        break;
      }

      case 'mediafire': {
        if (!q || !isUrl(q)) return reply(`Example: ${prefix}mediafire https://mediafire.com/file/...`);
        try {
          const apis = [
            `https://api.siputzx.my.id/api/d/mediafire?url=${encodeURIComponent(q)}`,
            `https://apis.davidcyriltech.my.id/mediafire?url=${encodeURIComponent(q)}`
          ];
          let fileUrl = null, name = 'file', size = '';
          for (const api of apis) {
            try {
              const { data } = await axios.get(api, { timeout: 45000 });
              fileUrl = data?.result?.url || data?.result?.dl || data?.data?.url || data?.url;
              name = data?.result?.filename || data?.result?.name || data?.data?.filename || name;
              size = data?.result?.size || data?.data?.size || '';
              if (fileUrl && String(fileUrl).startsWith('http')) break;
              fileUrl = null;
            } catch (e) {}
          }
          if (!fileUrl) return reply('❌ MediaFire download failed.');
          await sock.sendMessage(from, {
            document: { url: fileUrl },
            fileName: name,
            mimetype: 'application/octet-stream',
            caption: `✅ MediaFire\n${name}${size ? `\nSize: ${size}` : ''}`
          }, { quoted: m });
        } catch (e) {
          await reply('❌ MediaFire failed.');
        } finally {
        }
        break;
      }

      case 'gdrive': {
        if (!q || !isUrl(q)) return reply(`Example: ${prefix}gdrive https://drive.google.com/...`);
        try {
          const apis = [
            `https://api.siputzx.my.id/api/d/gdrive?url=${encodeURIComponent(q)}`,
            `https://apis.davidcyriltech.my.id/gdrive?url=${encodeURIComponent(q)}`
          ];
          let fileUrl = null, name = 'gdrive-file';
          for (const api of apis) {
            try {
              const { data } = await axios.get(api, { timeout: 60000 });
              fileUrl = data?.result?.download || data?.result?.url || data?.data?.url || data?.url;
              name = data?.result?.name || data?.result?.filename || name;
              if (fileUrl && String(fileUrl).startsWith('http')) break;
              fileUrl = null;
            } catch (e) {}
          }
          if (!fileUrl) return reply('❌ Google Drive download failed.');
          await sock.sendMessage(from, {
            document: { url: fileUrl },
            fileName: name,
            mimetype: 'application/octet-stream',
            caption: `✅ Google Drive\n${name}`
          }, { quoted: m });
        } catch (e) {
          await reply('❌ GDrive failed.');
        } finally {
        }
        break;
      }

      case 'gitclone': {
        if (!q || !q.includes('github.com')) return reply(`Example: ${prefix}gitclone https://github.com/user/repo`);
        try {
          let link = q.trim().replace(/\.git$/, '');
          const parts = link.split('/');
          const user = parts[3];
          const repo = parts[4]?.split('#')[0]?.split('?')[0];
          if (!user || !repo) return reply('Invalid GitHub repo link.');
          const zipUrl = `https://github.com/${user}/${repo}/archive/refs/heads/main.zip`;
          await reply(`⏳ Downloading ${user}/${repo}...`);
          await sock.sendMessage(from, {
            document: { url: zipUrl },
            fileName: `${repo}.zip`,
            mimetype: 'application/zip',
            caption: `✅ GitHub\n${user}/${repo}`
          }, { quoted: m });
        } catch (e) {
          await reply(`❌ gitclone failed: ${e.message}`);
        }
        break;
      }

      case 'playdoc': {
        if (!q) return reply(`Example: ${prefix}playdoc song name`);
        try {
          const search = await yts(q);
          const video = search.videos[0];
          if (!video) return reply('No results found.');
          const apis = [
            `https://apis.davidcyriltech.my.id/download/ytmp3?url=${encodeURIComponent(video.url)}`,
            `https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(video.url)}`
          ];
          let audioUrl = null;
          for (const api of apis) {
            try {
              const { data } = await axios.get(api, { timeout: 45000 });
              audioUrl = data?.result?.download_url || data?.result?.url || data?.data?.url || data?.url;
              if (audioUrl && String(audioUrl).startsWith('http')) break;
              audioUrl = null;
            } catch (e) {}
          }
          if (!audioUrl) return reply('❌ Download failed.');
          await sock.sendMessage(from, {
            document: { url: audioUrl },
            mimetype: 'audio/mpeg',
            fileName: `${(video.title || 'song').slice(0, 40)}.mp3`,
            caption: video.title
          }, { quoted: m });
        } catch (e) {
          await reply('❌ playdoc failed.');
        } finally {
        }
        break;
      }

      // ==================== F: GROUP EXTRAS ====================
      case 'join': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        const textSrc = q || '';
        const match = textSrc.match(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/i);
        if (!match) return reply(`Provide a group invite link.\nExample: ${prefix}join https://chat.whatsapp.com/XXXX`);
        try {
          await sock.groupAcceptInvite(match[1]);
          await reply('✅ Joined group.');
        } catch (e) {
          await reply(`❌ Join failed: ${e.message}`);
        }
        break;
      }

      case 'leave': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        await reply('👋 Leaving...');
        try { await sock.groupLeave(from); } catch (e) { await reply(`❌ ${e.message}`); }
        break;
      }

      case 'gname': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!q) return reply(`Example: ${prefix}gname New Name`);
        try {
          await sock.groupUpdateSubject(from, q);
          await reply('✅ Group name updated.');
        } catch (e) {
          await reply(`❌ ${e.message}`);
        }
        break;
      }

      case 'gdesc': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        if (!q) return reply(`Example: ${prefix}gdesc New description`);
        try {
          await sock.groupUpdateDescription(from, q);
          await reply('✅ Group description updated.');
        } catch (e) {
          await reply(`❌ ${e.message}`);
        }
        break;
      }

      case 'glink': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        if (!isAdmin && !isSudoUser) return reply('🔒 A group admin or Sudo permission is required.');
        try {
          const code = await sock.groupInviteCode(from);
          await reply(`https://chat.whatsapp.com/${code}`);
        } catch (e) {
          await reply(`❌ ${e.message}`);
        }
        break;
      }

      case 'creategc': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        if (!q) return reply(`Example: ${prefix}creategc My Group`);
        try {
          const res = await sock.groupCreate(q, []);
          const jid = res?.gid || res?.id;
          await reply(`✅ Group created: ${q}\nJID: ${jid || 'ok'}`);
        } catch (e) {
          await reply(`❌ creategc failed: ${e.message}`);
        }
        break;
      }

      case 'ginfo': {
        if (!isGroup) return reply(config.MESSAGES.onlyGroup);
        try {
          const meta = await getGroupMetadataCached(sock, sessionId, from);
          const admins = (meta.participants || []).filter(p => p.admin).length;
          await reply(
            `*Group Info*\n` +
            `Name: ${meta.subject}\n` +
            `Members: ${(meta.participants || []).length}\n` +
            `Admins: ${admins}\n` +
            `Desc: ${(meta.desc || '-').slice(0, 300)}`
          );
        } catch (e) {
          await reply(`❌ ${e.message}`);
        }
        break;
      }

      case 'addnote': {
        if (!isOwner && !isModUser && !isSudoUser) return reply(config.MESSAGES.onlySudo);
        const name = (args[0] || '').trim();
        const ctx = m.message?.extendedTextMessage?.contextInfo || {};
        const quoted = ctx.quotedMessage;
        const noteText =
          quoted?.conversation ||
          quoted?.extendedTextMessage?.text ||
          args.slice(1).join(' ').trim() ||
          '';
        if (!name || !noteText) {
          return reply(`Usage:\nReply to text: ${prefix}addnote name\nOr: ${prefix}addnote name your note text`);
        }
        const notes = settings.get(sessionId, 'bot', 'notes', {}) || {};
        notes[name] = noteText;
        settings.set(sessionId, 'bot', 'notes', notes);
        await reply(`✅ Note saved as *${name}*`);
        break;
      }

      case 'delnote': {
        if (!isOwner && !isModUser && !isSudoUser) return reply(config.MESSAGES.onlySudo);
        const name = (args[0] || '').trim();
        if (!name) return reply(`Usage: ${prefix}delnote name`);
        const notes = settings.get(sessionId, 'bot', 'notes', {}) || {};
        if (!notes[name]) return reply(`No note named *${name}*`);
        delete notes[name];
        settings.set(sessionId, 'bot', 'notes', notes);
        await reply(`🗑️ Deleted note *${name}*`);
        break;
      }

      case 'allnotes': {
        if (!isOwner && !isModUser && !isSudoUser) return reply(config.MESSAGES.onlySudo);
        const notes = settings.get(sessionId, 'bot', 'notes', {}) || {};
        const keys = Object.keys(notes);
        if (!keys.length) return reply('No saved notes.');
        let out = '*All Notes*\n\n';
        for (const k of keys) out += `• *${k}*: ${String(notes[k]).slice(0, 200)}\n\n`;
        await reply(out.trim());
        break;
      }

      case 'getnote': {
        if (!isOwner && !isModUser && !isSudoUser) return reply(config.MESSAGES.onlySudo);
        const name = (args[0] || '').trim();
        if (!name) return reply(`Usage: ${prefix}getnote name`);
        const notes = settings.get(sessionId, 'bot', 'notes', {}) || {};
        if (!notes[name]) return reply(`Note *${name}* not found.`);
        await reply(`*${name}*\n${notes[name]}`);
        break;
      }

      case 'delallnote': {
        if (!isOwner && !isModUser) return reply(config.MESSAGES.onlyOwner);
        settings.set(sessionId, 'bot', 'notes', {});
        await reply('🗑️ All notes cleared.');
        break;
      }

      case 'ss': {
        let link = q || '';
        if (!link) {
          const ctx = m.message?.extendedTextMessage?.contextInfo || {};
          const qt = ctx.quotedMessage?.conversation || ctx.quotedMessage?.extendedTextMessage?.text || '';
          link = qt;
        }
        const urls = String(link).match(/https?:\/\/[^\s]+/gi) || [];
        if (!urls.length) return reply(`Example: ${prefix}${command} https://example.com`);
        const target = urls[0];
        const device =
          command === 'ssphone' ? 'phone' :
          command === 'sstab' ? 'tablet' :
          'desktop';
        try {
          const apis = [
            `https://api.siputzx.my.id/api/tools/ssweb?url=${encodeURIComponent(target)}&theme=${device}`,
            `https://api.screenshotmachine.com/?key=demo&url=${encodeURIComponent(target)}&dimension=1024x768`,
            `https://image.thum.io/get/width/1200/crop/1200/${encodeURIComponent(target)}`,
            `https://mini.s-shot.ru/1024x768/JPEG/1024/Z100/?${encodeURIComponent(target)}`
          ];
          let img = null;
          for (const api of apis) {
            try {
              const { data, status, headers } = await axios.get(api, {
                responseType: 'arraybuffer',
                timeout: 60000,
                headers: { 'User-Agent': 'Mozilla/5.0' },
                validateStatus: s => s < 500
              });
              const ctype = String(headers['content-type'] || '');
              if (status === 200 && data && data.byteLength > 2000 && (ctype.includes('image') || data.byteLength > 5000)) {
                img = Buffer.from(data);
                break;
              }
            } catch (e) {}
          }
          if (!img) return reply('❌ Screenshot failed. Site may block capture or APIs are busy.');
          await sock.sendMessage(from, {
            image: img,
            caption: `📸 ${device} screenshot\n${target}`
          }, { quoted: m });
        } catch (e) {
          await reply(`❌ Screenshot error: ${e.message}`);
        } finally {
        }
        break;
      }

      case 'audio2text': {
        try {
          const media = await downloadQuotedMedia(sock, m, ['audioMessage', 'videoMessage']);
          if (!media?.buffer?.length) return reply(`Reply to a voice note/audio with ${prefix}audio2text`);
          // Best-effort free STT endpoints
          let transcript = null;
          const FormData = require('form-data');
          const tries = [
            async () => {
              const form = new FormData();
              form.append('audio', media.buffer, { filename: 'audio.ogg', contentType: media.msg?.mimetype || 'audio/ogg' });
              const { data } = await axios.post('https://api.siputzx.my.id/api/tools/whisper', form, {
                headers: form.getHeaders(),
                timeout: 90000,
                validateStatus: s => s < 500
              });
              return data?.result || data?.text || data?.data?.text || null;
            },
            async () => {
              const form = new FormData();
              form.append('file', media.buffer, { filename: 'audio.ogg' });
              const { data } = await axios.post('https://apis.davidcyriltech.my.id/whisper', form, {
                headers: form.getHeaders(),
                timeout: 90000,
                validateStatus: s => s < 500
              });
              return data?.result || data?.text || null;
            }
          ];
          for (const fn of tries) {
            try {
              transcript = await fn();
              if (transcript) break;
            } catch (e) {}
          }
          if (!transcript) return reply('❌ Could not transcribe audio. Free STT APIs are busy.');
          await reply(`📝 *Transcript*\n\n${transcript}`);
        } catch (e) {
          await reply(`❌ audio2text failed: ${e.message}`);
        } finally {
        }
        break;
      }

      case 'wm': {
        let num = '';
        const targets = getTargetJids(m, args);
        if (targets[0]) num = String(targets[0]).replace(/[^0-9]/g, '');
        else if (q) num = String(q).replace(/[^0-9]/g, '');
        else if (!isGroup) num = String(from).replace(/[^0-9]/g, '');
        if (!num) return reply(`Tag/reply a user or provide number:\n${prefix}wm @user\n${prefix}wm 234xxxxxxxxxx`);
        await reply(`https://wa.me/${num}`);
        break;
      }

      case 'temp-url': {
        try {
          const media = await downloadQuotedMedia(sock, m, ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']);
          if (!media?.buffer?.length) return reply(`Reply to media with ${prefix}temp-url`);
          const FormData = require('form-data');
          let link = null;
          // 0x0.st
          try {
            const form = new FormData();
            form.append('file', media.buffer, { filename: 'file.bin' });
            const { data } = await axios.post('https://0x0.st', form, {
              headers: form.getHeaders(),
              timeout: 60000,
              responseType: 'text',
              transformResponse: [d => d]
            });
            if (typeof data === 'string' && data.startsWith('http')) link = data.trim();
          } catch (e) {}
          // catbox
          if (!link) {
            try {
              const form = new FormData();
              form.append('reqtype', 'fileupload');
              form.append('fileToUpload', media.buffer, { filename: 'upload.bin' });
              const { data } = await axios.post('https://catbox.moe/user/api.php', form, {
                headers: form.getHeaders(),
                timeout: 60000,
                responseType: 'text',
                transformResponse: [d => d]
              });
              if (typeof data === 'string' && data.startsWith('http')) link = data.trim();
            } catch (e) {}
          }
          if (!link) return reply('❌ Temporary upload failed.');
          await reply(`🔗 Temp URL:\n${link}`);
        } catch (e) {
          await reply(`❌ temp-url failed: ${e.message}`);
        } finally {
        }
        break;
      }

      case 'pdf': {
        try {
          if (q && !q.toLowerCase().startsWith('send')) {
            // minimal text PDF without extra deps
            const content = q;
            const lines = [];
            const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
            const wrapped = [];
            let row = '';
            for (const word of content.split(/\s+/)) {
              if ((row + ' ' + word).trim().length > 80) {
                wrapped.push(row.trim());
                row = word;
              } else row = (row + ' ' + word).trim();
            }
            if (row) wrapped.push(row);
            const textOps = wrapped.slice(0, 40).map((ln, i) => `BT /F1 12 Tf 50 ${750 - i * 16} Td (${esc(ln)}) Tj ET`).join('\n');
            const stream = `BT /F1 12 Tf 50 770 Td (${esc('𝙅𝙄𝙉𝙓 𝙆9 PDF')}) Tj ET\n` + textOps;
            const objs = [];
            objs.push('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n');
            objs.push('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n');
            objs.push('3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n');
            objs.push(`4 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream\nendobj\n`);
            objs.push('5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n');
            let pdf = '%PDF-1.4\n';
            const offsets = [0];
            for (const o of objs) {
              offsets.push(Buffer.byteLength(pdf, 'utf8'));
              pdf += o;
            }
            const xrefPos = Buffer.byteLength(pdf, 'utf8');
            pdf += `xref\n0 ${objs.length + 1}\n`;
            pdf += '0000000000 65535 f \n';
            for (let i = 1; i < offsets.length; i++) {
              pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
            }
            pdf += `trailer<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
            await sock.sendMessage(from, {
              document: Buffer.from(pdf, 'utf8'),
              mimetype: 'application/pdf',
              fileName: 'jinx-k9.pdf',
              caption: '📄 PDF'
            }, { quoted: m });
            break;
          }
          const media = await downloadQuotedMedia(sock, m, ['imageMessage']);
          if (!media?.buffer?.length) {
            return reply(`Usage:\n${prefix}pdf your text here\nOr reply to an image with ${prefix}pdf`);
          }
          // For images without pdfkit: send as document image with note
          await sock.sendMessage(from, {
            document: media.buffer,
            mimetype: 'image/jpeg',
            fileName: 'image.jpg',
            caption: '📄 Image ready. Full multi-image PDF merge needs extra server libs.'
          }, { quoted: m });
        } catch (e) {
          await reply(`❌ pdf failed: ${e.message}`);
        }
        break;
      }

      case 'trt': {
        // canonical translate command with lang-code style: .trt en bonjour
        if (!q && !(m.message?.extendedTextMessage?.contextInfo?.quotedMessage)) {
          return reply(`Example:\n${prefix}trt en bonjour\n${prefix}trt es hello`);
        }
        // fall through handled by rewriting args into translate behavior
        try {
          const parts = String(q || '').trim().split(/\s+/);
          let code = 'en';
          let phrase = q;
          if (parts[0] && /^[a-z]{2,5}$/i.test(parts[0]) && parts.length > 1) {
            code = parts[0].toLowerCase();
            phrase = parts.slice(1).join(' ');
          }
          const ctx = m.message?.extendedTextMessage?.contextInfo || {};
          if (!phrase) {
            phrase = ctx.quotedMessage?.conversation || ctx.quotedMessage?.extendedTextMessage?.text || '';
          }
          if (!phrase) return reply(`Example: ${prefix}trt en bonjour`);
          const apis = [
            `https://api.mymemory.translated.net/get?q=${encodeURIComponent(phrase)}&langpair=auto|${encodeURIComponent(code)}`,
            `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(code)}&dt=t&q=${encodeURIComponent(phrase)}`
          ];
          let out = null;
          for (const api of apis) {
            try {
              const { data } = await axios.get(api, { timeout: 20000 });
              if (data?.responseData?.translatedText) { out = data.responseData.translatedText; break; }
              if (Array.isArray(data) && data[0]) {
                out = data[0].map(x => x[0]).join('');
                break;
              }
            } catch (e) {}
          }
          if (!out) return reply('❌ Translate failed.');
          await reply(`🌐 *${code}*\n${out}`);
        } catch (e) {
          await reply(`❌ trt failed: ${e.message}`);
        }
        break;
      }

      case 'ngl': {
        if (!q || !q.includes(':')) {
          return reply(`Example:\n${prefix}ngl username:hello there`);
        }
        const idx = q.indexOf(':');
        const user = q.slice(0, idx).trim();
        const msg = q.slice(idx + 1).trim();
        if (!user || !msg) return reply(`Example:\n${prefix}ngl username:hello there`);
        try {
          // Public NGL-style endpoints (best effort)
          const tries = [
            `https://api.siputzx.my.id/api/tools/ngl?username=${encodeURIComponent(user)}&message=${encodeURIComponent(msg)}`,
            `https://ngl.link/api/submit`,
          ];
          let ok = false;
          for (const api of tries) {
            try {
              if (api.includes('ngl.link')) {
                const { data, status } = await axios.post(api, {
                  username: user,
                  question: msg,
                  deviceId: 'matrix-' + Date.now()
                }, { timeout: 20000, validateStatus: s => s < 500 });
                if (status >= 200 && status < 300) { ok = true; break; }
              } else {
                const { data, status } = await axios.get(api, { timeout: 20000, validateStatus: s => s < 500 });
                if (status === 200 && (data?.success || data?.status || data?.result)) { ok = true; break; }
              }
            } catch (e) {}
          }
          if (ok) await reply('✅ NGL message sent.');
          else await reply('❌ NGL send failed. Username may be invalid or API is down.');
        } catch (e) {
          await reply(`❌ ngl failed: ${e.message}`);
        } finally {
        }
        break;
      }

      case 'ip': {
        try {
          const { data } = await axios.get('https://api.ipify.org?format=json', { timeout: 15000 });
          await reply(`🌐 Bot public IP: *${data?.ip || data}*`);
        } catch (e) {
          try {
            const { data } = await axios.get('https://ifconfig.me/ip', { timeout: 15000, responseType: 'text', transformResponse: [d => d] });
            await reply(`🌐 Bot public IP: *${String(data).trim()}*`);
          } catch (e2) {
            await reply('❌ Could not fetch IP.');
          }
        }
        break;
      }

      default: {
        // Unknown command — ignore silently
        break;
      }
      }
    } finally {
      await clearReact(sock, m);
    }
  } catch (e) {
    console.error('Handler error:', e);
    // Previously this only logged — a command that threw would just go
    // silent from the user's side, which reads as "the bot ignored me."
    // Now, if this was actually a recognized command attempt, tell them
    // something broke instead of leaving them guessing.
    try {
      if (isCmd) {
        await sock.sendMessage(
          m.key.remoteJid,
          { text: responseAction('error', 'Something went wrong while running that command. Please try again in a moment.') },
          { quoted: m }
        );
      }
    } catch (err) {}
    try { if (isCmd) await clearReact(sock, m); } catch (err) {}
  }
}

/**
 * Format welcome/goodbye text placeholders
 */
async function formatGroupTemplate(sock, sessionId, groupJid, template, userJid) {
  let meta = {};
  try { meta = await sock.groupMetadata(groupJid); } catch (e) {}
  const now = new Date();
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('en-GB');
  const name = userJid.split('@')[0];
  let text = String(template || '')
    .replace(/@user/gi, `@${name}`)
    .replace(/@number/gi, name)
    .replace(/@time/gi, time)
    .replace(/@date/gi, date)
    .replace(/@group/gi, meta.subject || 'Group')
    .replace(/@desc/gi, meta.desc || '')
    .replace(/@members/gi, String((meta.participants || []).length))
    .replace(/@bot/gi, config.BOT_NAME);
  return { text, mentions: [userJid], wantsPp: /@pp/i.test(template || '') };
}

/**
 * Welcome / Goodbye / Anti-Promote / Anti-Demote
 */
async function onGroupParticipantsUpdate(sock, update, sessionId) {
  try {
    const { id, action } = update || {};
    if (!id || !action) return;

    const rawParticipants = Array.isArray(update.participants) ? update.participants : [];
    const metaBefore = await getGroupMetadataCached(sock, sessionId, id).catch(() => null);
    const participantJids = [];
    for (const raw of rawParticipants) {
      const normalized = await normalizeParticipantJid(sock, raw, metaBefore?.participants || []);
      if (normalized) participantJids.push(normalized);
    }
    const participants = [...new Set(participantJids)];
    if (!participants.length) return;

    const rawAuthor = update.author || update.participant || update.authorPn || update.authorAlt || null;
    const author = await normalizeParticipantJid(sock, rawAuthor, metaBefore?.participants || []).catch(() => null);
    const botIds = new Set();
    const botId = String(sock.user?.id || '');
    const botLid = String(sock.user?.lid || '');
    const botNum = botId.split(':')[0].replace(/[^0-9]/g, '');
    if (botId) botIds.add(botId);
    if (botLid) botIds.add(botLid);
    if (botNum) {
      botIds.add(`${botNum}@s.whatsapp.net`);
      botIds.add(`${botNum}@c.us`);
      botIds.add(`${botNum}@lid`);
    }
    const isBotJid = async (jid) => {
      if (!jid) return false;
      if ([...botIds].some(v => identity.identitiesMatch(v, jid))) return true;
      const pn = await resolvePhoneJid(sock, jid, metaBefore?.participants || []).catch(() => null);
      return !!pn && [...botIds].some(v => identity.identitiesMatch(v, pn));
    };
    const actorIsBot = await isBotJid(author);

    // ----- ANTI FOREIGN -----
    if (action === 'add' && settings.featureOn(sessionId, id, 'antiforeign')) {
      const meta = metaBefore || await getGroupMetadataCached(sock, sessionId, id);
      const admins = new Set((meta?.participants || []).filter(p => p.admin).flatMap(p => [p.id, p.jid, p.phoneNumber, p.lid].filter(Boolean).map(String)));
      const foreign = participants.filter(jid => {
        if ([...admins].some(a => identity.identitiesMatch(a, jid))) return false;
        const n = String(jid).replace(/[^0-9]/g, '');
        return n && !n.startsWith('234');
      });
      for (const user of foreign) {
        try {
          await safeGroupParticipantsUpdate(sock, id, [user], 'remove', 'anti-foreign');
          await sock.sendMessage(id, { text: responseAction('moderation', `@${user.split('@')[0]} was removed by Anti-Foreign.`), mentions: [user] }).catch(() => {});
        } catch (e) {}
      }
    }

    // ----- ANTI PROMOTE -----
    if (action === 'promote' && settings.featureOn(sessionId, id, 'antipromote')) {
      for (const user of participants) {
        if (isBotAction(sessionId, id, user, 'promote')) continue;
        if (await isBotJid(user)) {
          await sock.sendMessage(id, { text: '🛡️ The bot admin status was changed and is protected.' }).catch(() => {});
          continue;
        }
        if (!actorIsBot && author) {
          try {
            markBotAction(sessionId, id, user, 'demote');
            await safeGroupParticipantsUpdate(sock, id, [user], 'demote', 'anti-promote target rollback');
          } catch (e) {
            console.error(`[${sessionId}] anti-promote target rollback failed:`, e?.message || e);
          }
          if (!identity.identitiesMatch(author, user)) {
            try {
              markBotAction(sessionId, id, author, 'demote');
              await safeGroupParticipantsUpdate(sock, id, [author], 'demote', 'anti-promote actor rollback');
            } catch (e) {
              console.error(`[${sessionId}] anti-promote actor rollback failed:`, e?.message || e);
            }
          }
          await sock.sendMessage(id, {
            text: `⚠️ @${String(author).split('@')[0]} you can't promote @${String(user).split('@')[0]}. You have been demoted for trying to promote them. @${String(user).split('@')[0]} has been demoted too.`,
            mentions: [author, user]
          }).catch(() => {});
        }
      }
      return;
    }

    // ----- ANTI DEMOTE -----
    if (action === 'demote' && settings.featureOn(sessionId, id, 'antidemote')) {
      for (const user of participants) {
        if (isBotAction(sessionId, id, user, 'demote')) continue;
        if (await isBotJid(user)) {
          try {
            markBotAction(sessionId, id, user, 'promote');
            await safeGroupParticipantsUpdate(sock, id, [user], 'promote', 'anti-demote bot rollback');
          } catch (e) {
            console.error(`[${sessionId}] anti-demote bot rollback failed:`, e?.message || e);
          }
          if (author && !actorIsBot) {
            try {
              markBotAction(sessionId, id, author, 'demote');
              await safeGroupParticipantsUpdate(sock, id, [author], 'demote', 'anti-demote actor rollback');
            } catch (e) {
              console.error(`[${sessionId}] anti-demote actor rollback failed:`, e?.message || e);
            }
            await sock.sendMessage(id, {
              text: `⚠️ @${String(author).split('@')[0]} you can't demote the bot. You have been demoted for trying to demote it. The bot has been promoted back.`,
              mentions: [author]
            }).catch(() => {});
          }
          continue;
        }
        if (isBotAction(sessionId, id, user, 'demote')) continue;
        if (author && !actorIsBot) {
          try {
            markBotAction(sessionId, id, user, 'promote');
            await safeGroupParticipantsUpdate(sock, id, [user], 'promote', 'anti-demote target rollback');
          } catch (e) {
            console.error(`[${sessionId}] anti-demote target rollback failed:`, e?.message || e);
          }
          if (!identity.identitiesMatch(author, user)) {
            try {
              markBotAction(sessionId, id, author, 'demote');
              await safeGroupParticipantsUpdate(sock, id, [author], 'demote', 'anti-demote actor rollback');
            } catch (e) {
              console.error(`[${sessionId}] anti-demote actor rollback failed:`, e?.message || e);
            }
          }
          await sock.sendMessage(id, {
            text: `⚠️ @${String(author).split('@')[0]} you can't demote @${String(user).split('@')[0]}. You have been demoted for trying to demote them. @${String(user).split('@')[0]} has been promoted back.`,
            mentions: [author, user]
          }).catch(() => {});
        }
      }
      return;
    }

    // ----- PROMOTE / DEMOTE ALERT -----
    if ((action === 'promote' || action === 'demote') && author) {
      const verb = action === 'promote' ? 'promoted' : 'demoted';
      for (const user of participants) {
        await sock.sendMessage(id, {
          text: `⚠️ @${String(author).split('@')[0]} ${verb} @${String(user).split('@')[0]} ${action === 'promote' ? 'to admin' : 'from admin'}.`,
          mentions: [author, user]
        }).catch(() => {});
      }
    }

    // ----- WELCOME -----
    if (action === 'add' && settings.isWelcome(sessionId, id)) {
      const textTemplate = settings.getWelcomeText(sessionId, id);
      for (const user of participants) {
        try {
          const formatted = await formatGroupTemplate(sock, sessionId, id, textTemplate, user);
          if (formatted.wantsPp) {
            try {
              const pp = await sock.profilePictureUrl(user, 'image');
              await sock.sendMessage(id, {
                image: { url: pp },
                caption: formatted.text.replace(/@pp/gi, '').trim(),
                mentions: formatted.mentions
              });
            } catch {
              await sock.sendMessage(id, { text: formatted.text.replace(/@pp/gi, '').trim(), mentions: formatted.mentions });
            }
          } else {
            await sock.sendMessage(id, { text: formatted.text, mentions: formatted.mentions });
          }
        } catch (e) {
          console.error('welcome error:', e.message);
        }
      }
    }

    // ----- GOODBYE -----
    if (action === 'remove' && settings.isGoodbye(sessionId, id)) {
      const textTemplate = settings.getGoodbyeText(sessionId, id);
      for (const user of participants) {
        try {
          const formatted = await formatGroupTemplate(sock, sessionId, id, textTemplate, user);
          await sock.sendMessage(id, {
            text: formatted.text.replace(/@pp/gi, '').trim(),
            mentions: formatted.mentions
          });
        } catch (e) {}
      }
    }

  } catch (e) {
    console.error('Group update error:', e?.stack || e?.message || e);
  }
}

module.exports = handler;
module.exports.onGroupParticipantsUpdate = onGroupParticipantsUpdate;
