const { getBaileys } = require('./lib/baileys');
const pino = require('pino');
let chalk; try { chalk = require('chalk'); } catch { chalk = { red:s=>s, green:s=>s, yellow:s=>s, cyan:s=>s, blue:s=>s, gray:s=>s, greenBright:s=>s }; }
const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const db = require('./lib/database');
const settings = require('./lib/settings');
const sessionRuntime = require('./core/runtime');
const sessionRegistry = require('./core/session-registry');
const contacts = require('./lib/contacts');

const SESSIONS_DIR = path.resolve(config.SESSIONS_DIR);
fs.ensureDirSync(SESSIONS_DIR);

const sockets = new Map();
const sessionMeta = new Map();
const reconnecting = new Set();
const pairingInProgress = new Set();
// Recent messages for anti-delete (sessionId -> Map(msgKeyId -> payload))
const messageCache = new Map();
const antiDeleteLogged = new Map();
const antiEditLogged = new Map();
const rememberContacts = contacts.rememberContacts;

/** Validate creds.json before attempting restore. Quarantine corrupt files. */
function validateCredsFile(sessionPath) {
  const credsPath = path.join(sessionPath, 'creds.json');
  if (!fs.existsSync(credsPath)) return { ok: false, reason: 'missing' };
  try {
    const raw = fs.readFileSync(credsPath, 'utf8');
    if (!raw || !raw.trim()) return { ok: false, reason: 'empty' };
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { ok: false, reason: 'not-object' };
    // Baileys multi-file auth expects at least noiseKey / registered or me
    if (data.registered === false && !data.me && !data.noiseKey) {
      return { ok: false, reason: 'incomplete' };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: 'parse-error', error: e.message };
  }
}

function quarantineSession(sessionId, reason) {
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  const badDir = path.join(SESSIONS_DIR, '_corrupt');
  try {
    fs.ensureDirSync(badDir);
    const dest = path.join(badDir, `${sessionId}_${Date.now()}`);
    if (fs.existsSync(sessionPath)) {
      fs.moveSync(sessionPath, dest, { overwrite: true });
      console.error(chalk.red(`[${sessionId}] quarantined corrupt session (${reason}) -> ${dest}`));
    }
  } catch (e) {
    console.error(`[${sessionId}] quarantine failed:`, e.message);
    try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch {}
  }
}


async function resolvePhoneJid(sock, jid) {
  const raw = String(jid || '');
  if (!raw) return null;
  if (raw.endsWith('@s.whatsapp.net')) return raw;
  try {
    const mapped = await sock?.signalRepository?.lidMapping?.getPNForLID?.(raw);
    if (mapped) return String(mapped).endsWith('@s.whatsapp.net') ? String(mapped) : String(mapped) + '@s.whatsapp.net';
  } catch (e) {}
  return null;
}
async function displayIdentity(sock, sessionId, jid, pushName = '') {
  const raw = String(jid || '');
  if (pushName) return String(pushName);
  const pn = await resolvePhoneJid(sock, raw);
  const pnNum = pn ? pn.replace(/[^0-9]/g, '') : '';
  if (pnNum) return `+${pnNum}`;
  const rawNum = raw.replace(/[^0-9]/g, '');
  if (raw.endsWith('@lid')) return 'WhatsApp user';
  return rawNum ? `+${rawNum}` : (raw || 'Unknown');
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

function cacheMessage(sessionId, m) {
  try {
    if (!m?.key?.id) return;
    if (!messageCache.has(sessionId)) messageCache.set(sessionId, new Map());
    const map = messageCache.get(sessionId);
    map.set(m.key.id, {
      key: m.key,
      message: m.message,
      pushName: m.pushName,
      ts: Date.now()
    });
    // keep last 500 per session
    if (map.size > 500) {
      const first = map.keys().next().value;
      map.delete(first);
    }
  } catch (e) {}
}
const logger = pino({ level: 'silent' });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}


async function getSafeBaileysVersion(B, timeoutMs = 12000) {
  const live = async () => {
    if (typeof B.fetchLatestWaWebVersion === 'function') {
      try {
        const r = await B.fetchLatestWaWebVersion();
        if (r?.version) return r.version;
      } catch (e) {}
    }
    if (typeof B.fetchLatestBaileysVersion === 'function') {
      try {
        const r = await B.fetchLatestBaileysVersion();
        if (r?.version) return r.version;
      } catch (e) {}
    }
    return undefined;
  };
  try {
    return await Promise.race([
      live(),
      new Promise(resolve => setTimeout(() => resolve(undefined), timeoutMs))
    ]);
  } catch {
    return undefined;
  }
}

async function tgNotify(telegramId, text) {
  if (!telegramId || telegramId === '0') return;
  try {
    const { bot } = require('./bot');
    await bot.telegram.sendMessage(telegramId, text, { parse_mode: 'Markdown' });
  } catch (e) {}
}

function destroySocket(sessionId) {
  try {
    const sock = sockets.get(sessionId);
    if (sock) {
      try {
        if (sock._zeusPresenceInterval) {
          clearInterval(sock._zeusPresenceInterval);
          sock._zeusPresenceInterval = null;
        }
      } catch (e) {}
      try { sock.ev.removeAllListeners(); } catch (e) {}
      try { if (sock.ws) sock.ws.close(); } catch (e) {}
      try { sock.end(undefined); } catch (e) {}
    }
  } catch (e) {}
  sockets.delete(sessionId);
  // Free per-session caches to prevent unbounded memory growth across reconnects
  try { messageCache.delete(sessionId); } catch (e) {}
  try { antiDeleteLogged.delete(sessionId); } catch (e) {}
  try { antiEditLogged.delete(sessionId); } catch (e) {}
}

// Wipes a session's stored creds and unregisters it, exactly like a real
// WhatsApp logout does — used both by the loggedOut handler below and by
// the Bad MAC auto-repair.
async function forceRepairSession(sessionId, reason = 'session corrupted') {
  const meta = sessionMeta.get(sessionId) || {};
  const telegramId = meta.telegramId;
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  destroySocket(sessionId);
  try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch (e) {}
  sessionMeta.delete(sessionId);
  try { sessionRegistry.unregister(sessionId); } catch (e) {}
  try { settings.del(sessionId, 'bot', 'connectedAt'); sessionRuntime.markDisconnected(sessionId); const rt = require('./core/runtime'); rt.flush(); } catch (e) {}
  try { db.removeConnection(String(telegramId), sessionId); } catch (e) {}
  await tgNotify(
    telegramId,
    `⚠️ Session \`${sessionId}\` was reset (${reason}).\n\nThis usually means WhatsApp's encryption keys for this session got out of sync — there's no way to repair that in place, so it's been wiped. Run /connect and pair again to get a fresh, working session.`
  );
}

// Bad MAC errors come straight from the libsignal package's own internal
// console.error calls (they bypass the pino logger passed into Baileys
// entirely, so they can't be scoped to one session by construction). We
// watch for a burst of them and, when there's exactly one active session,
// treat it the same as a real logout: wipe it and tell the owner to
// re-pair. With more than one active session we can't safely guess which
// one is actually broken, so we notify instead of guessing — use
// /repair <sessionId> in Telegram to force it manually.
const BAD_MAC_WINDOW_MS = 2 * 60 * 1000;
const BAD_MAC_THRESHOLD = 6;
let badMacTimestamps = [];
let badMacPatched = false;

function watchForBadMacErrors() {
  if (badMacPatched) return;
  badMacPatched = true;
  const origError = console.error.bind(console);
  console.error = (...args) => {
    origError(...args);
    try {
      const text = args.map((a) => (a && a.stack) || String(a)).join(' ');
      if (!text.includes('Bad MAC')) return;
      const now = Date.now();
      badMacTimestamps.push(now);
      badMacTimestamps = badMacTimestamps.filter((t) => now - t <= BAD_MAC_WINDOW_MS);
      if (badMacTimestamps.length < BAD_MAC_THRESHOLD) return;
      badMacTimestamps = [];

      const activeIds = [...sockets.keys()];
      if (activeIds.length === 1) {
        forceRepairSession(activeIds[0], 'repeated Bad MAC decryption errors').catch(() => {});
      } else if (activeIds.length > 1) {
        for (const [, meta] of sessionMeta) {
          tgNotify(
            meta.telegramId,
            `⚠️ Repeated "Bad MAC" decryption errors detected, but you have multiple active sessions so I can't tell which one is affected.\n\nActive sessions: ${activeIds.join(', ')}\n\nIf one of your bots seems stuck/broken, run /repair <sessionId> to force a fresh re-pair for it.`
          ).catch(() => {});
          break; // one notice is enough, sessionMeta may repeat the same owner
        }
      }
    } catch (e) {}
  };
}
watchForBadMacErrors();

function safeSaveCreds(saveCreds, sessionPath) {
  return async () => {
    try {
      fs.ensureDirSync(sessionPath);
      await saveCreds();
    } catch (e) {
      if (!String(e.message || e).includes('ENOENT')) {
        console.error('saveCreds error:', e.message);
      }
    }
  };
}

function hasNestedMessageKey(value, wanted, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 7 || seen.has(value)) return false;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (wanted.has(key)) return true;
    const child = value[key];
    if (child && typeof child === 'object' && hasNestedMessageKey(child, wanted, depth + 1, seen)) return true;
  }
  return false;
}

function findGroupJid(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return null;
  seen.add(value);
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (typeof child === 'string' && child.endsWith('@g.us')) return child;
    if (child && typeof child === 'object') {
      const hit = findGroupJid(child, depth + 1, seen);
      if (hit) return hit;
    }
  }
  return null;
}

// Where anti-delete / anti-edit logs get sent:
//   'owner' (default) -> the bot's own DM, private to you
//   'chat'             -> back into the same chat the message was deleted/edited in
function getLogDestination(sessionId, feature) {
  const key = feature === 'edit' ? 'antieditDest' : 'antideleteDest';
  const v = settings.get(sessionId, 'bot', key, 'owner');
  return v === 'chat' ? 'chat' : 'owner';
}

function resolveLogTarget(sock, sessionId, feature, chatJid) {
  const dest = getLogDestination(sessionId, feature);
  if (dest === 'chat' && chatJid) return chatJid;
  const botNum = (sock.user?.id || '').split(':')[0].replace(/[^0-9]/g, '');
  return botNum ? botNum + '@s.whatsapp.net' : null;
}

async function sendAntiDeleteLog(sock, sessionId, cached, deleterJid, deleterAlt = '', source = 'update') {
  try {
    if (!cached?.key?.id) return;
    if (!antiDeleteLogged.has(sessionId)) antiDeleteLogged.set(sessionId, new Set());
    const seen = antiDeleteLogged.get(sessionId);
    if (seen.has(cached.key.id)) return;
    seen.add(cached.key.id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
    const chatJid = cached.key?.remoteJid || '';
    const target = resolveLogTarget(sock, sessionId, 'delete', chatJid);
    if (!target) return;
    const senderJid = cached.key?.participant || cached.key?.participantAlt || cached.key?.remoteJid || '';
    const actualDeleter = deleterJid || deleterAlt || '';
    const senderName = await displayIdentity(sock, sessionId, senderJid, cached.pushName || '');
    const deleterName = await displayIdentity(sock, sessionId, actualDeleter, '');
    const resolvedSender = await resolvePhoneJid(sock, senderJid) || senderJid;
    const resolvedDeleter = actualDeleter ? (await resolvePhoneJid(sock, actualDeleter) || actualDeleter) : '';
    const senderTag = resolvedSender ? `@${String(resolvedSender).split('@')[0]}` : senderName;
    const deleterTag = resolvedDeleter ? `@${String(resolvedDeleter).split('@')[0]}` : deleterName;
    const mentionList = [...new Set([resolvedSender, resolvedDeleter].filter(j => j && String(j).includes('@')) )];
    const chatLabel = String(chatJid).endsWith('@g.us') ? 'Group chat' : 'Private chat';
    const msg = cached.message || {};
    const text = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
    const timestamp = new Date().toLocaleString('en-GB', { hour12: false });
    const isGroup = String(chatJid).endsWith('@g.us');
    const sameChat = target === chatJid;
    const log = sameChat
      ? (
          `╭─〔 𝙅𝙄𝙉𝙓 𝙆9 • ANTI-DELETE 〕\n` +
          `│ 👤 User    : ${senderName || senderTag}\n` +
          (deleterName && deleterName !== senderName ? `│ 🗑️ Deleted : ${deleterName}\n` : '') +
          (text ? `│ 💬 Message : ${text}\n` : `│ 💬 Message : [media]\n`) +
          `╰──────────────`
        )
      : (
          `╭─〔 𝙅𝙄𝙉𝙓 𝙆9 • ANTI-DELETE 〕\n` +
          `│ 👤 User    : ${senderName || senderTag}\n` +
          (deleterName ? `│ 🗑️ Deleted : ${deleterName}\n` : '') +
          `│ 💬 Chat    : ${chatLabel}\n` +
          (text ? `│ 💬 Message : ${text}\n` : `│ 💬 Message : [media]\n`) +
          `╰──────────────`
        );
    await sock.sendMessage(target, { text: log, mentions: mentionList });

    // Forward the deleted media after the log.
    const { downloadContentFromMessage } = await getBaileys();
    const viewOnce = msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg.viewOnceMessageV2Extension?.message;
    const inner = viewOnce || msg;
    const type = Object.keys(inner || {}).find((k) => ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'].includes(k));
    if (type) {
      const stream = await downloadContentFromMessage(inner[type], type.replace('Message', ''));
      const buffer = await collectMediaWithLimit(stream, 200 * 1024 * 1024, 'deleted media');
      const payload = {};
      if (type === 'imageMessage') payload.image = buffer;
      else if (type === 'videoMessage') payload.video = buffer;
      else if (type === 'audioMessage') payload.audio = buffer;
      else if (type === 'stickerMessage') payload.sticker = buffer;
      else payload.document = buffer;
      payload.caption = sameChat ? `🗑️ Deleted media` : `🗑️ Deleted media from ${senderName}`;
      await sock.sendMessage(target, payload);
    }
  } catch (e) {
    console.error(`[${sessionId}] anti-delete log error:`, e.message);
  }
}

async function sendAntiEditLog(sock, sessionId, cached, newMessage, editorJid, editStamp) {
  try {
    if (!cached?.key?.id) return;
    if (!antiEditLogged.has(sessionId)) antiEditLogged.set(sessionId, new Map());
    const seen = antiEditLogged.get(sessionId);
    const dedupeKey = `${cached.key.id}:${editStamp || Date.now()}`;
    if (seen.has(dedupeKey)) return;
    seen.set(dedupeKey, true);
    if (seen.size > 1000) seen.delete(seen.keys().next().value);
    const chatJid = cached.key?.remoteJid || '';
    const target = resolveLogTarget(sock, sessionId, 'edit', chatJid);
    if (!target) return;
    const senderJid = cached.key?.participant || cached.key?.participantAlt || cached.key?.remoteJid || '';
    const senderName = await displayIdentity(sock, sessionId, senderJid, cached.pushName || '');
    const editorName = editorJid ? await displayIdentity(sock, sessionId, editorJid, '') : senderName;
    const chatLabel = String(chatJid).endsWith('@g.us') ? 'Group chat' : 'Private chat';
    const oldMsg = cached.message || {};
    const oldText = oldMsg.conversation || oldMsg.extendedTextMessage?.text || oldMsg.imageMessage?.caption || oldMsg.videoMessage?.caption || '(no text)';
    const newText = newMessage?.conversation || newMessage?.extendedTextMessage?.text || newMessage?.imageMessage?.caption || newMessage?.videoMessage?.caption || '(no text)';
    const isGroup = String(chatJid).endsWith('@g.us');
    const sameChat = target === chatJid;
    const log = sameChat
      ? (
          `╭───────────────◆\n` +
          `│  *MESSAGE EDITED*\n` +
          `├───────────────◆\n` +
          `│ ▸ Sender  : ${senderName}\n` +
          `│ ▸ Before  : ${oldText}\n` +
          `│ ▸ After   : ${newText}\n` +
          `╰───────────────◆`
        )
      : (
          `╭───────────────◆\n` +
          `│  *EDIT LOG*\n` +
          `├───────────────◆\n` +
          `│ ▸ Timestamp: ${new Date().toLocaleString('en-GB', { hour12: false })}\n` +
          `│ ▸ Sender   : ${senderName}\n` +
          `│ ▸ Chat     : ${chatLabel}\n` +
          `│ ▸ Group chat: ${isGroup ? 'Yes' : 'No'}\n` +
          `│ ▸ Before   : ${oldText}\n` +
          `│ ▸ After    : ${newText}\n` +
          `╰───────────────◆`
        );
    await sock.sendMessage(target, { text: log });
    // Keep the cache in sync so a later delete of this message shows the latest text.
    cached.message = newMessage || cached.message;
  } catch (e) {
    console.error(`[${sessionId}] anti-edit log error:`, e.message);
  }
}

async function saveStatusToDm(sock, sessionId, m) {
  const botNum = (sock.user?.id || '').split(':')[0].replace(/[^0-9]/g, '');
  if (!botNum) return;
  const ownerJid = botNum + '@s.whatsapp.net';
  const posterJid = m.key?.participant || m.key?.participantAlt || m.key?.remoteJid || '';
  const posterName = await displayIdentity(sock, sessionId, posterJid, m.pushName || '');
  const msg = m.message || {};
  const caption = `📥 Status from ${posterName}` + (msg.imageMessage?.caption || msg.videoMessage?.caption ? `\n${msg.imageMessage?.caption || msg.videoMessage?.caption}` : '');
  const type = Object.keys(msg).find((k) => ['imageMessage', 'videoMessage', 'audioMessage'].includes(k));
  if (type) {
    const { downloadContentFromMessage } = await getBaileys();
    const stream = await downloadContentFromMessage(msg[type], type.replace('Message', ''));
    const buffer = await collectMediaWithLimit(stream, 200 * 1024 * 1024, 'status media');
    const payload = {};
    if (type === 'imageMessage') payload.image = buffer;
    else if (type === 'videoMessage') payload.video = buffer;
    else if (type === 'audioMessage') payload.audio = buffer;
    payload.caption = caption;
    await sock.sendMessage(ownerJid, payload);
  } else {
    const text = msg.conversation || msg.extendedTextMessage?.text || '';
    if (text) await sock.sendMessage(ownerJid, { text: `📥 Status from ${posterName}:\n${text}` });
  }
}

function bindEvents(sock, sessionId, telegramId, sessionPath) {
  let notifiedConnecting = false;
  let notifiedOpen = false;

  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect, qr, isNewLogin } = update;

      if (connection) {
        console.log(chalk.cyan(`[${sessionId}] state: ${connection}`));
      }

      if (connection === 'connecting' && !notifiedConnecting) {
        notifiedConnecting = true;
        console.log(chalk.yellow(`[${sessionId}] Connecting to WhatsApp...`));
      }

      if (isNewLogin) {
        console.log(chalk.green(`[${sessionId}] New login detected (code accepted)`));
        // Do not send an intermediate Telegram status. The user gets one
        // definitive notification when the WhatsApp session is actually open.
      }

      if (connection === 'open' && !notifiedOpen) {
        notifiedOpen = true;
        console.log(chalk.green(`✅ WhatsApp connected: ${sessionId}`));
        pairingInProgress.delete(sessionId);
        sockets.set(sessionId, sock);
        sessionMeta.set(sessionId, { telegramId: String(telegramId), phone: sessionId });
        reconnecting.delete(sessionId);

        // Each WhatsApp session owns its own connection timestamp. Persist it
        // so a panel/process restart does not reset this session's runtime.
        try {
          const connectedAt = sessionRuntime.markConnected(sessionId);
          settings.set(sessionId, 'bot', 'connectedAt', connectedAt);
        } catch (e) {}

        try { db.addConnection(String(telegramId), sessionId, sessionId); } catch (e) {}
        try {
          if (!settings.get(sessionId, 'bot', 'prefix')) {
            settings.setPrefix(sessionId, config.DEFAULT_PREFIX);
          }
          if (!settings.get(sessionId, 'bot', 'worktype')) {
            settings.set(sessionId, 'bot', 'worktype', 'private');
          }
        } catch (e) {}
        // Save all known bot identities (phone + lid) for private-mode checks in groups
        try {
          const ids = new Set();
          const u = sock.user || {};
          const me = {};
          for (const v of [u.id, u.lid, me.id, me.lid, sessionId]) {
            if (!v) continue;
            const s = String(v);
            ids.add(s);
            const num = s.split(':')[0].replace(/[^0-9]/g, '');
            if (num) {
              ids.add(num);
              ids.add(num + '@s.whatsapp.net');
              ids.add(num + '@lid');
            }
          }
          settings.set(sessionId, 'bot', 'ownerIds', [...ids]);
          // Register this WhatsApp account as a 𝙅𝙄𝙉𝙓 𝙆9 session identity. Other
          // 𝙅𝙄𝙉𝙓 𝙆9 sessions use this registry to ignore its messages, preventing
          // bot-to-bot command/reaction loops when multiple sessions share a group.
          sessionRegistry.register(sessionId, [...ids, sessionId, u.id, u.lid]);
          console.log(chalk.gray(`[${sessionId}] Owner IDs saved: ${[...ids].join(', ')}`));
        } catch (e) {}

        // Notify Telegram only once per process open (notifiedOpen guards this)
        await tgNotify(
          telegramId,
          `✅ *Number connected*

Number: \`${sessionId}\`
Prefix: *${config.DEFAULT_PREFIX}*
Use \`${config.DEFAULT_PREFIX}menu\` on WhatsApp.`
        );

        // First successful connection: send the requested welcome to the
        // connected WhatsApp account's private/self chat. The flag is persisted
        // so reconnects (including a 515 restart) do not spam the DM again.
        try {
          const alreadyWelcomed = settings.get(sessionId, 'bot', 'welcomeSent', false);
          if (!alreadyWelcomed) {
            const privateJid = `${String(sessionId).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
            if (privateJid.startsWith('@')) throw new Error('Invalid private chat JID');

            await sock.sendMessage(privateJid, {
              text: `╔══════════════════════╗\n      ⚡ *𝙅𝙄𝙉𝙓 𝙆9*\n╚══════════════════════╝\n\n✅ *Connected successfully!*\n\n┌─ *Session info*\n│ Status: *Online*\n│ Prefix: *${config.DEFAULT_PREFIX}*\n│ Help: *${config.DEFAULT_PREFIX}menu*\n└─\n\n📢 *Join the official group*\n_Get updates • support • new features_\n\n🔗 ${config.GROUP_INVITE}\n\n_Thank you for connecting to 𝙅𝙄𝙉𝙓 𝙆9._`
            });
            settings.set(sessionId, 'bot', 'welcomeSent', true);
          }
        } catch (e) {
          console.log(chalk.red(`[${sessionId}] Welcome DM failed: ${e?.message || e}`));
        }
        return;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || '';
        console.log(chalk.yellow(`[${sessionId}] close: ${statusCode} | ${errMsg}`));

        // A pairing socket can legitimately close while WhatsApp registers the
        // newly linked account. Treating that transient close as an "offline"
        // event was the reason users saw "session went offline" immediately
        // before the final "Number connected" message.
        const wasPairing = pairingInProgress.has(sessionId);

        const credsPath = path.join(sessionPath, 'creds.json');
        let registered = false;
        try {
          if (fs.existsSync(credsPath)) {
            registered = !!fs.readJsonSync(credsPath).registered;
          }
        } catch (e) {}

        destroySocket(sessionId);

        const { DisconnectReason } = await getBaileys();
        if (statusCode === DisconnectReason.loggedOut) {
          pairingInProgress.delete(sessionId);
          try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch (e) {}
          sessionMeta.delete(sessionId);
          sessionRegistry.unregister(sessionId);
          try { settings.del(sessionId, 'bot', 'connectedAt'); sessionRuntime.markDisconnected(sessionId); const rt = require('./core/runtime'); rt.flush(); } catch (e) {}
          try { db.removeConnection(String(telegramId), sessionId); } catch (e) {}
          await tgNotify(telegramId, `⚠️ Session \`${sessionId}\` was logged out.`);
          return;
        }

        // Only report a real offline event after the session is already
        // established. Pairing closes are an internal transition, not downtime.
        if (!wasPairing && telegramId && telegramId !== '0') {
          tgNotify(telegramId, '🔴 WhatsApp session `' + sessionId + '` went *offline*.').catch(() => {});
        }

        // If pairing and creds became registered, reconnect instead of wiping
        if (wasPairing && registered) {
          console.log(chalk.cyan(`[${sessionId}] Pairing creds saved — reconnecting to finish...`));
          pairingInProgress.delete(sessionId);
          setTimeout(() => {
            startExistingSession(sessionId, telegramId).catch(() => {});
          }, 2000);
          return;
        }

        if (wasPairing) {
          try {
            if (fs.existsSync(sessionPath) && !registered) fs.removeSync(sessionPath);
          } catch (e) {}
          pairingInProgress.delete(sessionId);
          await tgNotify(
            telegramId,
            `❌ Pairing failed for \`${sessionId}\`.\nReason: ${statusCode || errMsg || 'timeout'}\n\nUse /connect again and enter the *new* code quickly.`
          );
          return;
        }

        if (!reconnecting.has(sessionId)) {
          reconnecting.add(sessionId);
          setTimeout(() => {
            startExistingSession(sessionId, telegramId)
              .catch(() => {})
              .finally(() => reconnecting.delete(sessionId));
          }, 5000);
        }
      }
    } catch (e) {
      console.error(`[${sessionId}] connection.update error:`, e.message);
    }
  });

  // When creds update to registered during pairing
  sock.ev.on('creds.update', async () => {
    try {
      if (pairingInProgress.has(sessionId)) {
        console.log(chalk.green(`[${sessionId}] Creds registered`));
      }
    } catch (e) {}
  });

  sock.ev.on('contacts.upsert', (contacts) => rememberContacts(sessionId, contacts));
  sock.ev.on('contacts.update', (contacts) => rememberContacts(sessionId, contacts));

  sock.ev.on('messages.upsert', async (upsert) => {
    try {
      if (upsert.type !== 'notify' && upsert.type !== 'append') return;
      const messages = Array.isArray(upsert.messages) ? upsert.messages : [];
      for (const m of messages) {
        try {
          if (!m) continue;

          // Cache every received message first so anti-delete also works for
          // ordinary self-sent messages and for batches containing many messages.
          if (m.message) cacheMessage(sessionId, m);

          // Allow fromMe for commands OR emoji/sticker replies (secret VV unlock).
          if (m.key?.fromMe) {
            const preview = (
              m.message?.conversation ||
              m.message?.extendedTextMessage?.text ||
              m.message?.imageMessage?.caption || ''
            ).trim();
            const isSticker = !!m.message?.stickerMessage;
            const isEmoji = preview.length > 0 && preview.length <= 8 &&
              /^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D])+$/u.test(preview);
            const hasQuote = !!(
              m.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
              m.message?.stickerMessage?.contextInfo?.quotedMessage
            );
            const isCmdLike = /^[\?\.\!\/\#]/.test(preview);
            if (!isCmdLike && !(hasQuote && (isEmoji || isSticker))) continue;
          }

          // Hard isolation between 𝙅𝙄𝙉𝙓 𝙆9 sessions: if the sender is another
          // connected 𝙅𝙄𝙉𝙓 𝙆9 WhatsApp account, this session ignores the message
          // completely. Human users are unaffected.
          const matrixBotCandidates = [
            m.key?.participant,
            m.key?.participantAlt,
            m.key?.remoteJid,
            m.key?.remoteJidAlt
          ].filter(Boolean);
          if (sessionRegistry.isFromOtherSession(sessionId, matrixBotCandidates)) continue;

          // Status envelopes can contain group-status payloads. Route those to
          // the real group moderation path; ordinary statuses remain isolated.
          if (m.key?.remoteJid === 'status@broadcast') {
            const isGroupStatusPayload = hasNestedMessageKey(
              m.message,
              new Set(['groupStatusMessageV2', 'groupStatusMessage', 'groupStatusMentionMessage', 'groupMentionedMessage'])
            ) || hasNestedMessageKey(m.message, new Set(['isGroupStatus']));

            if (isGroupStatusPayload) {
              const groupJid = findGroupJid(m.message);
              if (groupJid) {
                const routed = {
                  ...m,
                  key: { ...m.key, remoteJid: groupJid },
                  _matrixOriginalKey: m.key,
                };
                const handler = require('./handler');
                await handler(sock, routed, sessionId);
              }
            } else {
              if (settings.get(sessionId, 'bot', 'autostatus', false)) {
                await sock.readMessages([m.key]).catch(() => {});
              }
              if (settings.get(sessionId, 'bot', 'statusreact', false)) {
                const statusReactionEmojis = ['❤️', '🔥', '😍', '😂', '😮', '👏', '💯', '✨', '🥰', '😎'];
                const emoji = statusReactionEmojis[Math.floor(Math.random() * statusReactionEmojis.length)];
                const reactionKey = {
                  remoteJid: 'status@broadcast',
                  id: String(m.key?.id || ''),
                  fromMe: false,
                  ...(m.key?.participant ? { participant: String(m.key.participant) } : {}),
                  ...(m.key?.participantAlt ? { participantAlt: String(m.key.participantAlt) } : {})
                };
                if (reactionKey.id) {
                  await sock.sendMessage('status@broadcast', { react: { text: emoji, key: reactionKey } }).catch((e) => {
                    console.error(`[${sessionId}] status reaction failed:`, e?.message || e);
                  });
                }
              }
              if (settings.get(sessionId, 'bot', 'statussave', false)) {
                await saveStatusToDm(sock, sessionId, m).catch((e) => {
                  console.error(`[${sessionId}] statussave error:`, e.message);
                });
              }
            }
            continue;
          }

          // Some builds surface a revoke protocol message directly on upsert.
          // messages.update below remains the primary v7 path.
          try {
            if (settings.get(sessionId, 'bot', 'antidelete', false) && m.message?.protocolMessage) {
              const proto = m.message.protocolMessage;
              const isRevoke = proto.type === 0 || proto.type === 1 || proto.type === 'REVOKE' || String(proto.type || '').toUpperCase().includes('REVOKE');
              if (isRevoke) {
                const stubKey = proto.key || {};
                const cached = stubKey.id ? messageCache.get(sessionId)?.get(stubKey.id) : null;
                if (cached) await sendAntiDeleteLog(sock, sessionId, cached, m.key?.participant || m.key?.participantAlt || m.pushName || 'Unknown', m.key?.participantAlt || '', 'upsert');
              }
            }
          } catch (e) {}

          // Anti-edit: WhatsApp delivers edits as a protocolMessage of type
          // MESSAGE_EDIT (14) carrying the new content in `editedMessage`,
          // with `key` pointing back at the original message.
          try {
            if (settings.get(sessionId, 'bot', 'antiedit', false) && m.message?.protocolMessage) {
              const proto = m.message.protocolMessage;
              const isEdit = proto.type === 14 || proto.type === 'MESSAGE_EDIT' || String(proto.type || '').toUpperCase().includes('EDIT');
              if (isEdit) {
                const stubKey = proto.key || {};
                const cached = stubKey.id ? messageCache.get(sessionId)?.get(stubKey.id) : null;
                if (cached) {
                  const editorJid = m.key?.participant || m.key?.participantAlt || cached.key?.remoteJid || '';
                  await sendAntiEditLog(sock, sessionId, cached, proto.editedMessage, editorJid, m.messageTimestamp || Date.now());
                }
              }
            }
          } catch (e) {}

          const handler = require('./handler');
          if (m.message) {
            // Messages in this loop are processed one at a time (await in a
            // for-loop) — if a single command hangs (e.g. an API call with
            // no timeout that never resolves), every message after it for
            // this session would be stuck until the panel is restarted.
            // This caps any one command at 45s so the queue always keeps
            // moving even if that command never gets a proper reply out.
            await Promise.race([
              handler(sock, m, sessionId),
              new Promise((_, reject) => setTimeout(() => reject(new Error('command timed out after 45s')), 45000))
            ]).catch((e) => console.error(`[${sessionId}] handler timeout/error:`, e.message));
          }
        } catch (e) {
          console.error(`[${sessionId}] single message handler error:`, e.message);
        }
      }
    } catch (e) {
      console.error(`[${sessionId}] messages.upsert error:`, e.message);
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    try {
      const handler = require('./handler');
      if (handler.onGroupParticipantsUpdate) {
        await handler.onGroupParticipantsUpdate(sock, update, sessionId);
      }
    } catch (e) {}
  });

  // Reject calls silently when enabled
  sock.ev.on('call', async (calls) => {
    try {
      const list = Array.isArray(calls) ? calls : [calls];
      for (const c of list) {
        if (c.status !== 'offer') continue;
        const rejectOn = settings.get(sessionId, 'bot', 'rejectcall', false);
        if (!rejectOn) continue;
        try {
          if (typeof sock.rejectCall === 'function') {
            await sock.rejectCall(c.id, c.from);
          } else if (sock.updateBlockStatus) {
            // fallback: end via query if available
          }
          console.log(`[${sessionId}] Rejected call from ${c.from}`);
        } catch (e) {
          console.error(`[${sessionId}] rejectCall error:`, e.message);
        }
      }
    } catch (e) {}
  });

  // Anti-delete: Baileys v7 emits REVOKE through messages.update.
  sock.ev.on('messages.update', async (updates) => {
    try {
      if (!settings.get(sessionId, 'bot', 'antidelete', false)) return;
      for (const u of updates || []) {
        const deleted = u.update?.message === null || u.update?.messageStubType === 1 || u.update?.status === 0 || !!u.update?.messageStubParameters;
        if (!deleted) continue;
        const id = u.key?.id;
        if (!id) continue;
        const cached = messageCache.get(sessionId)?.get(id);
        if (!cached) continue;
        const deleterJid = u.key?.participant || u.key?.participantAlt || u.key?.remoteJid || '';
        const deleterAlt = u.key?.participantAlt || '';
        await sendAntiDeleteLog(sock, sessionId, cached, deleterJid, deleterAlt, 'messages.update');
      }
    } catch (e) {
      console.error(`[${sessionId}] anti-delete update error:`, e.message);
    }
  });

  // Anti-edit fallback: some builds surface the edit as a plain content
  // update on messages.update instead of a protocolMessage on upsert.
  sock.ev.on('messages.update', async (updates) => {
    try {
      if (!settings.get(sessionId, 'bot', 'antiedit', false)) return;
      for (const u of updates || []) {
        const editedContent = u.update?.message?.editedMessage?.message ||
          (u.update?.message && u.update.message.protocolMessage?.type === 14 ? u.update.message.protocolMessage.editedMessage : null);
        if (!editedContent) continue;
        const id = u.key?.id;
        if (!id) continue;
        const cached = messageCache.get(sessionId)?.get(id);
        if (!cached) continue;
        const editorJid = u.key?.participant || u.key?.participantAlt || u.key?.remoteJid || '';
        await sendAntiEditLog(sock, sessionId, cached, editedContent, editorJid, u.update?.messageTimestamp || Date.now());
      }
    } catch (e) {
      console.error(`[${sessionId}] anti-edit update error:`, e.message);
    }
  });

  sock.ev.on('messages.delete', async (event) => {
    try {
      if (!settings.get(sessionId, 'bot', 'antidelete', false)) return;
      const keys = event?.keys || [];
      for (const key of keys) {
        const cached = messageCache.get(sessionId)?.get(key?.id);
        if (!cached) continue;
        await sendAntiDeleteLog(sock, sessionId, cached, '', '', 'messages.delete');
      }
    } catch (e) {}
  });

  // Always online presence loop when enabled
  if (!sock._zeusPresenceInterval) {
    sock._zeusPresenceInterval = setInterval(async () => {
      try {
        if (settings.get(sessionId, 'bot', 'alwaysonline', false)) {
          await sock.sendPresenceUpdate('available');
        }
      } catch (e) {}
    }, 25000);
  }
}

function createSocket(state, version, saveCreds, sessionPath, B) {
  // Canonical browser identity is required for pairing-code flow.
  // Non-standard labels (e.g. "Desktop") are often rejected by WhatsApp with
  // "Couldn't link device". Ubuntu/Chrome is the most widely accepted.
  const makeWASocket = B.default || B.makeWASocket;
  const makeCacheableSignalKeyStore = B.makeCacheableSignalKeyStore;
  const sock = makeWASocket({
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    version,
    // Use the stable Ubuntu/Chrome browser identity for the WhatsApp socket.
    // Do NOT advertise an Android client here: WhatsApp pairing/connection
    // currently has better compatibility with WEB_BROWSER/Ubuntu+Chrome.
    // Device labels shown by .getdevice are detected separately from message
    // IDs and must not be tied to the socket's browser identity.
    browser: (B.Browsers || {}).ubuntu
      ? B.Browsers.ubuntu('Chrome')
      : ['Ubuntu', 'Chrome', '120.0.0.0'],
    connectTimeoutMs: 120000,
    defaultQueryTimeoutMs: 120000,
    keepAliveIntervalMs: 25000,
    emitOwnEvents: true,
    fireInitQueries: true,
    generateHighQualityLinkPreview: true,
    linkPreviewImageThumbnailWidth: 1200,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    retryRequestDelayMs: 250,
    maxMsgRetryCount: 5,
    getMessage: async () => undefined
  });
  sock.ev.on('creds.update', safeSaveCreds(saveCreds, sessionPath));
  return sock;
}

async function startPairing(phone, telegramId, ctx) {
  const sessionId = String(phone).replace(/\D/g, '');
  if (!sessionId || sessionId.length < 10 || sessionId.length > 15) {
    return { error: 'Invalid number. Example: 2348123456789 (no +)' };
  }

  try {
    const existingOwner = db.getConnectionOwner(sessionId);
    if (existingOwner && String(existingOwner) !== String(telegramId) && String(telegramId) !== String(config.OWNER_TELEGRAM_ID)) {
      return { error: 'This WhatsApp number is already owned by another account.' };
    }
  } catch (e) {}

  if (sockets.has(sessionId) && !pairingInProgress.has(sessionId)) {
    // Check if actually open
    const existing = sockets.get(sessionId);
    if (existing?.user) {
      return { error: 'This number is already connected.' };
    }
  }
  if (pairingInProgress.has(sessionId)) {
    return { error: 'Pairing already in progress. Wait 30 seconds.' };
  }

  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  try {
    if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
  } catch (e) {}
  fs.ensureDirSync(sessionPath);

  pairingInProgress.add(sessionId);

  try {
    const B = await getBaileys();
    const { state, saveCreds } = await B.useMultiFileAuthState(sessionPath);

    const version = await getSafeBaileysVersion(B);
    console.log(chalk.gray(`Baileys WA version: ${version || 'library default'}`));

    const sock = createSocket(state, version, saveCreds, sessionPath, B);
    bindEvents(sock, sessionId, telegramId, sessionPath);
    sessionMeta.set(sessionId, { telegramId: String(telegramId), phone: sessionId });
    sockets.set(sessionId, sock);

    if (state.creds?.registered) {
      pairingInProgress.delete(sessionId);
      return { success: true, alreadyRegistered: true };
    }

    // Wait until the socket is actually ready (qr / connecting) before requesting
    // the pairing code. Fixed sleeps often produce dead codes that WhatsApp rejects.
    let code;
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Socket not ready for pairing (timeout)')), 25000);
        const onUpdate = (update) => {
          if (update.qr || update.connection === 'connecting' || update.connection === 'open') {
            clearTimeout(timeout);
            sock.ev.off('connection.update', onUpdate);
            resolve();
          }
        };
        sock.ev.on('connection.update', onUpdate);
        // Also resolve if already past connecting
      });

      // Small extra settle time after ready signal
      await sleep(1500);

      if (state.creds?.registered) {
        pairingInProgress.delete(sessionId);
        return { success: true, alreadyRegistered: true };
      }

      code = await sock.requestPairingCode(sessionId);
      code = String(code || '').replace(/[^0-9A-Za-z]/g, '');
      if (code.length === 8) {
        code = code.match(/.{1,4}/g).join('-');
      }
      console.log(chalk.green(`📱 Pairing code for ${sessionId}: ${code}`));
    } catch (err) {
      pairingInProgress.delete(sessionId);
      destroySocket(sessionId);
      try { fs.removeSync(sessionPath); } catch (e) {}
      return { error: 'Failed to get code: ' + (err.message || 'try again') };
    }

    // Watchdog: if still pairing after 2 min, notify
    setTimeout(async () => {
      if (pairingInProgress.has(sessionId)) {
        const credsPath = path.join(sessionPath, 'creds.json');
        let registered = false;
        try {
          if (fs.existsSync(credsPath)) registered = !!fs.readJsonSync(credsPath).registered;
        } catch (e) {}

        if (registered) {
          console.log(chalk.yellow(`[${sessionId}] Pairing watchdog: registered credentials detected; restarting silently.`));
          // Recover silently. The user receives only the final "Number connected"
          // notification from the actual connection-open event.
          destroySocket(sessionId);
          setTimeout(() => startExistingSession(sessionId, telegramId).catch(() => {}), 1500);
        } else {
          pairingInProgress.delete(sessionId);
          await tgNotify(telegramId, `❌ Pairing timed out for \`${sessionId}\`. Please use Connect WhatsApp again.`);
        }
      }
    }, 120000);

    return { code };
  } catch (e) {
    pairingInProgress.delete(sessionId);
    sockets.delete(sessionId);
    console.error(chalk.red(`[${sessionId}] startPairing error:`), e.message);
    try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch (err) {}
    return { error: e.message || 'Pairing failed' };
  }
}

async function startExistingSession(sessionId, telegramId = null) {
  // Recover persistent Telegram ownership after a process/panel restart.
  if (!telegramId || String(telegramId) === '0') {
    try { telegramId = db.getConnectionOwner(sessionId) || '0'; } catch (e) { telegramId = '0'; }
  }
  if (sockets.has(sessionId)) {
    const s = sockets.get(sessionId);
    if (s?.user) return s;
    destroySocket(sessionId);
  }

  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(path.join(sessionPath, 'creds.json'))) return null;

  const credsCheck = validateCredsFile(sessionPath);
  if (!credsCheck.ok) {
    console.error(chalk.red(`[${sessionId}] bad creds.json (${credsCheck.reason}${credsCheck.error ? ': ' + credsCheck.error : ''})`));
    quarantineSession(sessionId, credsCheck.reason);
    try {
      const owner = telegramId || db.getConnectionOwner(sessionId) || '0';
      await tgNotify(owner, '⚠️ Session `' + sessionId + '` had corrupt credentials and was quarantined.\nRun /connect to pair again.');
    } catch (e) {}
    return null;
  }

  try {
    const B = await getBaileys();
    const { state, saveCreds } = await B.useMultiFileAuthState(sessionPath);
    const version = await getSafeBaileysVersion(B);
    console.log(chalk.gray(`[${sessionId}] Baileys WA version: ${version || 'library default'}`));

    const sock = createSocket(state, version, saveCreds, sessionPath, B);
    bindEvents(sock, sessionId, telegramId || '0', sessionPath);
    sockets.set(sessionId, sock);
    console.log(chalk.cyan(`[${sessionId}] Session socket started`));
    return sock;
  } catch (e) {
    console.error(`[${sessionId}] startExistingSession:`, e.message);
    // Auth state load failures often mean unrecoverable key material
    const msg = String(e.message || e);
    if (/JSON|Unexpected|ENOENT|corrupt|invalid/i.test(msg)) {
      quarantineSession(sessionId, 'load-failed');
    }
    return null;
  }
}

async function loadAllSessions() {
  console.log(chalk.cyan('🔄 Loading existing WhatsApp sessions...'));
  try {
    if (!fs.existsSync(SESSIONS_DIR)) {
      console.log(chalk.yellow('No sessions folder yet.'));
      return;
    }
    const folders = fs.readdirSync(SESSIONS_DIR).filter((f) =>
      f !== '_corrupt' &&
      !f.startsWith('.') &&
      fs.existsSync(path.join(SESSIONS_DIR, f, 'creds.json'))
    );
    if (!folders.length) {
      console.log(chalk.gray('No saved WhatsApp sessions found.'));
      return;
    }

    // Start sockets independently. A slow/failing session must never block the
    // other saved sessions from restoring after a Spaceify/process restart.
    let restored = 0;
    await Promise.all(folders.map(async (folder) => {
      try {
        const sock = await startExistingSession(folder);
        if (sock) restored++;
      } catch (e) {
        console.error(`[${folder}] restore failed:`, e.message);
        // Give this session a second chance without affecting the others.
        setTimeout(() => {
          if (!sockets.has(folder)) startExistingSession(folder).catch(() => {});
        }, 10000);
      }
      await sleep(150);
    }));
    console.log(chalk.green(`Restore started for ${restored}/${folders.length} saved session(s).`));
  } catch (e) {
    console.error('loadAllSessions:', e.message);
  }
}

function getSocket(sessionId) {
  return sockets.get(sessionId);
}

function getAllSockets() {
  return sockets;
}

function getSessionStatus(sessionId) {
  const sock = sockets.get(String(sessionId));
  return { sessionId: String(sessionId), connected: !!sock?.user, phone: String(sessionId), runtime: sessionRuntime.display(String(sessionId)), meta: sessionMeta.get(String(sessionId)) || null };
}


let restoreWatchdogStarted = false;
function startSessionRestoreWatchdog() {
  if (restoreWatchdogStarted) return;
  restoreWatchdogStarted = true;
  const tick = async () => {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) return;
      const folders = fs.readdirSync(SESSIONS_DIR).filter((f) =>
        f !== '_corrupt' &&
        !f.startsWith('.') &&
        fs.existsSync(path.join(SESSIONS_DIR, f, 'creds.json'))
      );
      for (const sessionId of folders) {
        if (sockets.has(sessionId) || reconnecting.has(sessionId) || pairingInProgress.has(sessionId)) continue;
        try {
          await startExistingSession(sessionId);
        } catch (e) {
          console.error(`[${sessionId}] watchdog restore failed:`, e.message);
        }
        await sleep(200);
      }
    } catch (e) {
      console.error('session restore watchdog:', e.message);
    }
  };
  setInterval(tick, 60000).unref?.();
  setTimeout(tick, 15000).unref?.();
}

async function ownsSession(sessionId, telegramId) {
  const owner = String(telegramId || '');
  if (owner === String(config.OWNER_TELEGRAM_ID)) return true;
  const meta = sessionMeta.get(String(sessionId));
  if (meta?.telegramId && String(meta.telegramId) === owner) return true;
  try {
    return (db.getUserConnections(owner) || []).some(c => String(c.sessionId) === String(sessionId));
  } catch (e) {
    return false;
  }
}

async function restartSession(sessionId, telegramId = null) {
  const id = String(sessionId).replace(/\D/g, '');
  const owner = telegramId || db.getConnectionOwner(id) || '0';
  if (telegramId && !(await ownsSession(id, telegramId))) return false;
  destroySocket(id);
  await sleep(500);
  return !!(await startExistingSession(id, owner));
}

async function removeSession(phoneOrId, telegramId) {
  try {
    const sessionId = String(phoneOrId).replace(/\D/g, '');
    if (!(await ownsSession(sessionId, telegramId))) return false;
    pairingInProgress.delete(sessionId);
    destroySocket(sessionId);
    try { if (db.removeConnection) db.removeConnection(telegramId, sessionId); } catch (e) {}
    const folder = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(folder)) await fs.remove(folder).catch(() => {});
    sessionMeta.delete(sessionId);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  startPairing,
  startExistingSession,
  loadAllSessions,
  startSessionRestoreWatchdog,
  removeSession,
  getSocket,
  getAllSockets,
  getSessionStatus,
  restartSession,
  ownsSession,
  sockets,
  sessionMeta,
  messageCache,
  forceRepairSession
};
