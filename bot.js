const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
require('./lib/env').loadEnvFile();
const config = require('./config');
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const db = require('./lib/database');
const pkg = require('./package.json');
let chalk; try { chalk = require('chalk'); } catch { chalk = { red:s=>s, green:s=>s, yellow:s=>s, cyan:s=>s, blue:s=>s, gray:s=>s, greenBright:s=>s }; }

const bot = new Telegraf(BOT_TOKEN);

// Track every user who interacts with the bot so /broadcast has someone to reach.
bot.use(async (ctx, next) => {
  try {
    if (ctx.from?.id) {
      db.trackUser(ctx.from.id, [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '), ctx.from.username || '');
    }
  } catch (e) {}
  return next();
});

// Telegram control panel: the user-facing flow is keyboard-first.
// Slash commands remain only as backwards-compatible fallbacks; the main UI
// does not require users to type /connect, /sessions, etc.
async function registerBotCommands() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Open the 𝙅𝙄𝙉𝙓 𝙆9 control panel' },
      { command: 'reporterror', description: 'Report a bot error to the owner' },
      { command: 'connections', description: 'Owner: view all Telegram/WhatsApp connections' },
      { command: 'broadcast', description: 'Owner: broadcast to Telegram users' }
    ]);
    console.log('Telegram control-panel command registered');
  } catch (e) {
    console.error('setMyCommands failed:', e.message);
  }
}

const MENU_IMAGE = path.join(__dirname, 'media', 'jinx-telegram-menu.png');

function isOwner(ctx) {
  return String(ctx.from?.id || '') === String(config.OWNER_TELEGRAM_ID);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function userTag(ctx) {
  const id = String(ctx.from?.id || '');
  const name = escapeHtml(
    [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User'
  );
  return id ? `<a href="tg://user?id=${id}">${name}</a>` : name;
}

async function replyLongHtml(ctx, text, extra = {}) {
  const value = String(text || '');
  const chunks = [];
  let current = '';
  for (const line of value.split('\n')) {
    if ((current + (current ? '\n' : '') + line).length > 3800 && current) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  if (!chunks.length) chunks.push('');
  for (let i = 0; i < chunks.length; i++) {
    await ctx.reply(chunks[i], { parse_mode: 'HTML', ...(i === chunks.length - 1 ? extra : {}) });
  }
}

// Telegram uses a reply keyboard (the keyboard panel at the bottom of the chat).
// No inline buttons are used in the user-facing control panel.
function mainKeyboard(ctx = null) {
  const rows = [
    ['🔗 Connect WhatsApp'],
    ['📱 My Sessions', '📋 My Numbers'],
    ['🩺 Status', 'ℹ️ Help'],
    ['🆘 Report Error']
  ];
  if (ctx && isOwner(ctx)) rows.push(['👑 All Connections', '📢 Broadcast']);
  return Markup.keyboard(rows).resize().persistent();
}

const pendingPhoneRequests = new Set();
const pendingErrorReports = new Set();
const pendingBroadcasts = new Set();

function buildMenuText(ctx) {
  const userId = String(ctx.from?.id || '');

  return (
    `<b>⚡ 𝙅𝙄𝙉𝙓 𝙆9</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👋 Welcome, ${userTag(ctx)}\n\n` +
    `🤖 <b>WhatsApp Multi-Session Bot</b>\n` +
    `Connect and control your WhatsApp bot directly from Telegram.\n\n` +
    `👑 <b>Made by:</b> <a href="tg://user?id=${escapeHtml(config.OWNER_TELEGRAM_ID)}">PRIME</a> · ${escapeHtml(config.OWNER_TELEGRAM)}\n` +
    `🆔 <b>Your Telegram ID:</b> <code>${escapeHtml(userId)}</code>\n` +
    `📱 <b>WhatsApp Prefix:</b> <code>.</code>\n` +
    `🟢 <b>Access:</b> FREE for everyone\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `<i>Use the buttons below — no commands required.</i>`
  );
}

async function sendMainMenu(ctx) {
  const text = buildMenuText(ctx);

  try {
    if (fs.existsSync(MENU_IMAGE)) {
      await ctx.replyWithPhoto(
        { source: MENU_IMAGE },
        {
          caption: text,
          parse_mode: 'HTML',
          ...mainKeyboard(ctx)
        }
      );
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...mainKeyboard(ctx) });
    }
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'HTML', ...mainKeyboard(ctx) }).catch(() => {});
  }
}

// The Telegram control panel is permanently free.

// ==================== /start /menu ====================
bot.start(async (ctx) => {
  await sendMainMenu(ctx);
});

bot.command(['menu', 'help'], async (ctx) => {
  await sendMainMenu(ctx);
});

// ==================== USER COMMANDS ====================
bot.command(['delpair', 'deletepair', 'unlink'], async (ctx) => {

  const args = (ctx.message.text || '').trim().split(/\s+/).slice(1);
  const phone = (args[0] || '').replace(/\D/g, '');
  if (!phone) {
    return ctx.reply('Usage: /delpair &lt;number&gt;\nExample: /delpair 2348123456789', { parse_mode: 'HTML' });
  }

  try {
    const pair = require('./pair');
    const ok = await pair.removeSession(phone, String(ctx.from.id));
    if (ok) {
      await ctx.reply(`✅ Pair removed for <code>${phone}</code>`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`❌ No active pair found for <code>${phone}</code> (or not yours).`, { parse_mode: 'HTML' });
    }
  } catch (e) {
    await ctx.reply('❌ Failed to remove pair: ' + (e.message || 'error'));
  }
});

bot.command(['listpair', 'listpairs', 'mypairs'], async (ctx) => {
  const conns = db.getUserConnections(ctx.from.id);
  if (!conns.length) {
    return ctx.reply('You have no connected WhatsApp numbers yet.\nUse /connect &lt;number&gt;', { parse_mode: 'HTML' });
  }
  let text = '📱 <b>Your Connections</b>\n\n';
  conns.forEach((c, i) => {
    text += `${i + 1}. <code>${c.phone || c.sessionId}</code>\n`;
  });
  text += `\nTo remove: /delpair &lt;number&gt;`;
  await ctx.reply(text, { parse_mode: 'HTML' });
});



// ==================== GCAST — broadcast to all known groups of a session ====================
bot.command(['gcast', 'broadcastwa', 'gc'], async (ctx) => {
  const userId = String(ctx.from.id);
  const isDev = isOwner(ctx);
  const text = (ctx.message.text || '').replace(/^\/(?:gcast|broadcastwa|gc)(?:@\w+)?\s*/i, '').trim();
  if (!text) {
    return ctx.reply(
      '📢 <b>Group broadcast</b>\n\n' +
      'Sends a message to all groups your WhatsApp session knows.\n\n' +
      '<code>/gcast Hello everyone</code>\n' +
      '<code>/gcast from:2349xxx Maintenance in 5 min</code>',
      { parse_mode: 'HTML' }
    );
  }

  let sessionFilter = null;
  let msg = text;
  const m = text.match(/^from:(\d+)\s+([\s\S]+)$/i);
  if (m) {
    sessionFilter = m[1];
    msg = m[2].trim();
  }

  let conns = db.getUserConnections(userId) || [];
  if (isDev && !conns.length) {
    try {
      const pair = require('./pair');
      conns = [...pair.sockets.keys()].map(id => ({ sessionId: id }));
    } catch (_) {}
  }
  if (!conns.length) return ctx.reply('No connected WhatsApp. Use /connect first.');

  if (sessionFilter) {
    conns = conns.filter(c => String(c.sessionId || c.phone || '').replace(/\D/g, '') === sessionFilter);
    if (!conns.length) return ctx.reply('No matching session. /listpair');
  } else {
    conns = [conns[0]];
  }

  const pair = require('./pair');
  const settings = require('./lib/settings');
  let total = 0;
  let ok = 0;
  let fail = 0;
  const lines = [];

  for (const c of conns) {
    const sid = String(c.sessionId || c.phone || '').replace(/\D/g, '');
    if (!isDev) {
      const owned = await pair.ownsSession(sid, userId).catch(() => false);
      if (!owned) continue;
    }
    const sock = pair.getSocket(sid);
    if (!sock?.user) {
      lines.push(`❌ ${sid} offline`);
      continue;
    }
    const known = settings.get(sid, 'bot', 'knownGroups', {}) || {};
    const gids = Object.keys(known);
    if (!gids.length) {
      // try live fetch
      try {
        const all = await sock.groupFetchAllParticipating();
        Object.keys(all || {}).forEach(id => { known[id] = all[id]?.subject || id; });
        settings.set(sid, 'bot', 'knownGroups', known);
      } catch (_) {}
    }
    const groups = Object.keys(known);
    total += groups.length;
    lines.push(`📱 WA <code>${sid}</code> → ${groups.length} group(s)`);
    for (const gid of groups) {
      try {
        await sock.sendMessage(gid, { text: msg });
        ok++;
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        fail++;
      }
    }
  }

  await ctx.reply(
    `📢 <b>Gcast done</b>\n` +
    lines.join('\n') + '\n' +
    `✅ Sent: <b>${ok}</b>\n❌ Failed: <b>${fail}</b>\nTotal targets: ${total}`,
    { parse_mode: 'HTML' }
  );
});

// ==================== BACKUP ====================
bot.command(['backup', 'export'], async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply('Owner only.');
  try {
    const fs = require('fs-extra');
    const path = require('path');
    const os = require('os');
    const { execSync } = require('child_process');
    const tmp = path.join(os.tmpdir(), `jinx-backup-${Date.now()}.zip`);
    const root = process.cwd();
    // zip database + config (not sessions for size/privacy unless small)
    const files = ['database', 'config.js', 'config.env', 'package.json']
      .map(f => path.join(root, f))
      .filter(f => fs.existsSync(f));
    if (!files.length) return ctx.reply('Nothing to backup.');
    try {
      execSync(`zip -r ${JSON.stringify(tmp)} ${files.map(f => JSON.stringify(path.relative(root, f))).join(' ')}`, { cwd: root });
    } catch (e) {
      // fallback: send database folder files as document one by one
      const dbDir = path.join(root, 'database');
      if (fs.existsSync(dbDir)) {
        const list = fs.readdirSync(dbDir).slice(0, 10);
        await ctx.reply(`Backing up ${list.length} database file(s)…`);
        for (const name of list) {
          const fp = path.join(dbDir, name);
          if (fs.statSync(fp).isFile() && fs.statSync(fp).size < 45 * 1024 * 1024) {
            await ctx.replyWithDocument({ source: fp, filename: name });
          }
        }
        return;
      }
      return ctx.reply('Backup failed: ' + (e.message || 'zip error'));
    }
    if (fs.existsSync(tmp)) {
      await ctx.replyWithDocument({ source: tmp, filename: `jinx-backup-${Date.now()}.zip` });
      try { fs.removeSync(tmp); } catch (_) {}
    } else {
      await ctx.reply('Backup zip was not created.');
    }
  } catch (e) {
    await ctx.reply('Backup error: ' + (e.message || e));
  }
});

// ==================== REPORT VIA CONNECTED WHATSAPP ====================
// /report <target> <reason>
// /report <my_wa_session> <target> <reason>
// Uses your connected WhatsApp number(s) to file the report on WhatsApp.
bot.command(['report', 'reportspam', 'lapor'], async (ctx) => {
  const userId = String(ctx.from.id);
  const isDev = isOwner(ctx);

  const raw = (ctx.message.text || '').trim();
  const parts = raw.split(/\s+/).slice(1); // drop /report
  if (!parts.length) {
    return ctx.reply(
      '📢 <b>Report a number on WhatsApp</b>\n\n' +
      'Uses <b>your connected WhatsApp</b> to report someone.\n\n' +
      '<b>Usage</b>\n' +
      '• <code>/report 2348012345678 spam links in group</code>\n' +
      '• <code>/report 2348012345678 scammed me for money</code>\n' +
      '• With multiple WA numbers:\n' +
      '  <code>/report from:2349xxx 2348xxx selling fake crypto</code>\n' +
      '• Report from ALL your pairs:\n' +
      '  <code>/report all 2348xxx spam</code>\n\n' +
      'See pairs: /listpair',
      { parse_mode: 'HTML' }
    );
  }

  // Parse: optional "all" or "from:NUMBER" then target then reason
  let sessionFilter = null; // null = first online, 'all' = all, or specific phone
  let idx = 0;
  const first = parts[0].toLowerCase();
  if (first === 'all') {
    sessionFilter = 'all';
    idx = 1;
  } else if (first.startsWith('from:')) {
    sessionFilter = first.slice(5).replace(/\D/g, '') || parts[0].replace(/\D/g, '');
    idx = 1;
  }

  if (idx >= parts.length) {
    return ctx.reply('Missing target number.\nExample: <code>/report 2348012345678 spam</code>', { parse_mode: 'HTML' });
  }

  const targetRaw = parts[idx];
  const targetNum = String(targetRaw).replace(/\D/g, '');
  if (!targetNum || targetNum.length < 8) {
    return ctx.reply('Invalid target number.\nExample: <code>/report 2348012345678 spam ads</code>', { parse_mode: 'HTML' });
  }

  const reason = parts.slice(idx + 1).join(' ').trim();
  if (!reason || reason.length < 3) {
    return ctx.reply(
      'Please add a <b>reason</b> (why you are reporting).\n\n' +
      'Example:\n<code>/report ' + targetNum + ' posting scam payment links</code>',
      { parse_mode: 'HTML' }
    );
  }

  // Resolve which sessions belong to this Telegram user
  let conns = db.getUserConnections(userId) || [];
  if (isDev && sessionFilter === 'all' && !conns.length) {
    // Owner can report via any online socket
    try {
      const pair = require('./pair');
      conns = [...pair.sockets.keys()].map(id => ({ sessionId: id, phone: id }));
    } catch (_) {}
  }
  if (!conns.length) {
    return ctx.reply('You have no connected WhatsApp yet.\nUse /connect &lt;number&gt; first.', { parse_mode: 'HTML' });
  }

  let selected = conns;
  if (sessionFilter && sessionFilter !== 'all') {
    selected = conns.filter(c => String(c.sessionId || c.phone || '').replace(/\D/g, '') === sessionFilter);
    if (!selected.length) {
      return ctx.reply(
        `No connection matching <code>${sessionFilter}</code>.\nYour pairs: /listpair`,
        { parse_mode: 'HTML' }
      );
    }
  } else if (sessionFilter !== 'all') {
    // default: only the first connection (or first online)
    selected = [conns[0]];
  }

  const pair = require('./pair');
  const sessions = [];
  for (const c of selected) {
    const sid = String(c.sessionId || c.phone || '').replace(/\D/g, '');
    if (!isDev) {
      const owned = await pair.ownsSession(sid, userId).catch(() => false);
      if (!owned) continue;
    }
    const sock = pair.getSocket(sid);
    if (sock?.user) sessions.push({ sessionId: sid, sock });
  }

  if (!sessions.length) {
    return ctx.reply(
      '❌ None of your WhatsApp sessions are online right now.\n' +
      'Open /sessions and wait until status is 🟢 ONLINE, then try again.'
    );
  }

  await ctx.reply(
    `⏳ Reporting <code>${targetNum}</code> via <b>${sessions.length}</b> WhatsApp session(s)…\n` +
    `Reason: <i>${reason.replace(/</g, '')}</i>`,
    { parse_mode: 'HTML' }
  );

  const { reportFromSessions } = require('./services/wa-report');
  const results = await reportFromSessions(sessions, targetNum, reason, {
    source: 'telegram',
    by: `tg:${userId}`
  });

  // Tight diagnostic reply — every method attempt shown
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let text = '📢 <b>Report diagnostic</b>\n';
  text += `Target: <code>${esc(targetNum)}</code>\n`;
  text += `Reason: ${esc(reason).slice(0, 200)}\n\n`;

  for (const r of results) {
    text += r.ok
      ? `✅ <b>WA</b> <code>${esc(r.sessionId)}</code> — <b>SENT</b> via <code>${esc(r.method)}</code>\n`
      : `❌ <b>WA</b> <code>${esc(r.sessionId)}</code> — <b>NOT accepted</b>\n`;
    text += `Resolved JID: <code>${esc(r.jid)}</code>\n`;
    text += `Baileys: reportSpam=${r.baileysHasReportSpam ? 'yes' : 'no'} · query=${r.baileysHasQuery ? 'yes' : 'no'} · sendNode=${r.baileysHasSendNode ? 'yes' : 'no'}\n`;
    text += `<b>Attempts:</b>\n`;
    for (const a of (r.attempts || [])) {
      const icon = a.ok ? '✓' : '✗';
      text += `  ${icon} <code>${esc(a.method)}</code>: ${esc(a.detail).slice(0, 160)}\n`;
    }
    text += '\n';
  }

  const anyOk = results.some(r => r.ok);
  if (anyOk) {
    text += '✅ At least one session sent a report packet to WhatsApp servers.\n';
    text += '<i>Meta still decides whether to act. This is not the same UI confirmation as the official app.</i>';
  } else {
    text += '❌ No method succeeded on any session.\n';
    text += '<i>This Baileys build / WhatsApp rejected automated report packets. Use the official app: open chat → ⋮ → Report.</i>';
  }
  text += '\n📝 Reason also saved in <code>database/reports.json</code>';

  // Telegram message limit ~4096
  if (text.length > 4000) text = text.slice(0, 3990) + '\n…';
  await ctx.reply(text, { parse_mode: 'HTML' });
});

// ==================== PAIRING HELPER ====================
async function startPairFlow(ctx, phone) {
  pendingPhoneRequests.delete(String(ctx.from?.id || ''));
  // Connection limit (owner = unlimited)
  if (!isOwner(ctx)) {
    const uid = String(ctx.from.id);
    const current = db.getUserConnections(uid) || [];
    const max = db.getConnLimit(uid);
    // Count unique sessions
    const count = current.length;
    // Allow reconnect of same number
    const same = current.find(c => String(c.phone || c.sessionId).replace(/\D/g, '') === String(phone).replace(/\D/g, ''));
    if (!same && count >= max) {
      await ctx.reply(
        `⛔ <b>Connection limit reached</b>\n\n` +
        `You already have <b>${count}</b> WhatsApp connection(s).\n` +
        `Max allowed: <b>${max}</b>\n\n` +
        `Remove one with /delpair &lt;number&gt; or ask the owner to raise your limit.`,
        { parse_mode: 'HTML' }
      );
      return;
    }
  }
  const userId = String(ctx.from.id);
  await ctx.reply('⏳ Generating your WhatsApp pairing code…');
  try {
    const pair = require('./pair');
    const result = await pair.startPairing(phone, userId, ctx);
    if (result?.alreadyRegistered) {
      const connected = pair.getSessionStatus(phone).connected;
      await ctx.reply(
        connected
          ? `✅ <b>Number connected</b>\n\n<code>${phone}</code>`
          : `ℹ️ <b>Number already linked</b>\n\n<code>${phone}</code>\nCheck <b>My Sessions</b> for its status.`,
        { parse_mode: 'HTML', ...mainKeyboard(ctx) }
      );
      return;
    }
    if (result?.code) {
      const codeStr = String(result.code);
      await ctx.reply(
        `🔐 <b>Pairing Code</b>\n\n` +
        `Number: <code>${phone}</code>\n` +
        `Code: <code>${codeStr}</code>\n\n` +
        `WhatsApp → Linked Devices → Link a Device → <b>Link with phone number instead</b>\n\n` +
        `Copy the code above and enter it in WhatsApp.\n` +
        `⏱️ The code expires in about 60 seconds.`,
        { parse_mode: 'HTML', ...mainKeyboard(ctx) }
      );
    } else if (result?.error) {
      await ctx.reply('❌ ' + result.error);
    } else {
      await ctx.reply('❌ No pairing code was generated. Please try again.');
    }
  } catch (e) {
    console.error('Pairing error:', e);
    await ctx.reply('❌ Failed to generate pairing code. Please try again later.');
  }
}

// Listen for the phone number after the user chooses Connect WhatsApp.
bot.on('text', async (ctx, next) => {
  const text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return next();

  const userId = String(ctx.from?.id || '');

  if (pendingErrorReports.has(userId)) {
    pendingErrorReports.delete(userId);
    const report = db.addErrorReport({
      telegramId: userId,
      name: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' '),
      username: ctx.from?.username || '',
      error: text
    });
    const who = escapeHtml([ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User');
    const username = ctx.from?.username ? `@${escapeHtml(ctx.from.username)}` : 'no username';
    let connectionText = 'No WhatsApp connection recorded.';
    try {
      const pair = require('./pair');
      const conns = db.getUserConnections(userId) || [];
      if (conns.length) {
        connectionText = conns.map(c => {
          const sid = String(c.sessionId || c.phone || '').replace(/\D/g, '');
          const online = pair.getSessionStatus(sid).connected;
          return `${online ? '🟢' : '🔴'} <code>${escapeHtml(c.phone || sid)}</code>`;
        }).join(' · ');
      }
    } catch (_) {}
    const reportText =
      `🆘 <b>JINX K9 Error Report</b>\n\n` +
      `👤 <b>User:</b> ${who} (${username})\n` +
      `🆔 <b>Telegram ID:</b> <code>${escapeHtml(userId)}</code>\n` +
      `📱 <b>WhatsApp:</b> ${connectionText}\n` +
      `🕒 <b>Time:</b> ${new Date(report.createdAt).toISOString()}\n\n` +
      `<b>Error:</b>\n<pre>${escapeHtml(text).slice(0, 3500)}</pre>`;
    try { await bot.telegram.sendMessage(config.OWNER_TELEGRAM_ID, reportText, { parse_mode: 'HTML' }); } catch (e) {
      console.error('error report delivery failed:', e.message);
    }
    await ctx.reply('✅ Your error report has been sent to the bot owner. Thank you.', { ...mainKeyboard(ctx) });
    return;
  }

  if (pendingBroadcasts.has(userId)) {
    if (!isOwner(ctx)) { pendingBroadcasts.delete(userId); return next(); }
    pendingBroadcasts.delete(userId);
    const ids = db.getAllUserIds();
    if (!ids.length) return ctx.reply('No known Telegram users to broadcast to yet.', mainKeyboard(ctx));
    await ctx.reply(`📢 Broadcasting to ${ids.length} user(s)...`);
    let sent = 0, failed = 0;
    for (const id of ids) {
      try {
        await bot.telegram.sendMessage(id, `📢 <b>Announcement</b>\n\n${escapeHtml(text)}`, { parse_mode: 'HTML' });
        sent++;
      } catch (e) { failed++; }
      await new Promise(r => setTimeout(r, 60));
    }
    await ctx.reply(`✅ Broadcast finished.\nSent: ${sent}\nFailed (blocked/inactive): ${failed}`, mainKeyboard(ctx));
    return;
  }

  if (pendingPhoneRequests.has(userId) && /^\d{10,15}$/.test(text)) {
    pendingPhoneRequests.delete(userId);
    await startPairFlow(ctx, text);
    return;
  }

  return next();
});

// ==================== OWNER COMMANDS ====================
bot.command('broadcast', async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply(config.MESSAGES.onlyOwner);

  const text = ctx.message.text.replace(/^\/broadcast(@\S+)?\s*/, '').trim();
  if (!text) {
    return ctx.reply('Usage: /broadcast <message>\n\nSends the message to every user who has ever used this bot.');
  }

  const ids = db.getAllUserIds();
  if (!ids.length) return ctx.reply('No known users to broadcast to yet.');

  await ctx.reply(`📢 Broadcasting to ${ids.length} user(s)...`);
  let sent = 0, failed = 0;
  for (const id of ids) {
    try {
      await bot.telegram.sendMessage(id, `📢 <b>Announcement</b>\n\n${text}`, { parse_mode: 'HTML' });
      sent++;
    } catch (e) {
      failed++;
    }
    await new Promise(r => setTimeout(r, 60)); // gentle pacing to avoid Telegram rate limits
  }
  await ctx.reply(`✅ Broadcast finished.\nSent: ${sent}\nFailed (blocked/inactive): ${failed}`);
});

// ==================== OWNER: CONNECTIONS / LIMITS ====================

async function buildAllConnectionsDashboard() {
  const pair = require('./pair');
  const users = db.getUsers();
  const connections = (db.listAllConnections && db.listAllConnections()) || db.getConnections() || {};
  const tgIds = [...new Set([...Object.keys(users || {}), ...Object.keys(connections || {})])];
  if (!tgIds.length) return '📱 <b>All Connections</b>\n\nNo Telegram users or WhatsApp connections have been recorded yet.';

  let online = 0, offline = 0, waTotal = 0;
  let text = `📱 <b>JINX K9 · ALL TELEGRAM / WHATSAPP CONNECTIONS</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (const tgId of tgIds.sort()) {
    const u = users?.[tgId] || {};
    const name = escapeHtml(u.name || 'Unknown user');
    const username = u.username ? `@${escapeHtml(u.username)}` : 'no username';
    const list = Array.isArray(connections?.[tgId]) ? connections[tgId] : [];
    text += `\n👤 <b>${name}</b> · ${username}\n🆔 <code>${escapeHtml(tgId)}</code>\n`;
    if (!list.length) {
      text += `   📵 No WhatsApp connection\n`;
      continue;
    }
    for (const c of list) {
      const sid = String(c.sessionId || c.phone || '').replace(/\D/g, '');
      const st = pair.getSessionStatus(sid);
      waTotal++;
      if (st.connected) online++; else offline++;
      text += `   ${st.connected ? '🟢 ONLINE' : '🔴 OFFLINE'} · <code>${escapeHtml(c.phone || sid)}</code>\n`;
    }
  }
  text += `\n━━━━━━━━━━━━━━━━━━━━\n👥 Telegram IDs: <b>${tgIds.length}</b>\n📱 WhatsApp sessions: <b>${waTotal}</b>\n🟢 Online: <b>${online}</b> · 🔴 Offline: <b>${offline}</b>`;
  return text;
}

bot.command('connections', async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply('⛔ This command is only for the owner.');
  try {
    const text = await buildAllConnectionsDashboard();
    await replyLongHtml(ctx, text, mainKeyboard(ctx));
  } catch (e) {
    await ctx.reply('❌ Could not load all connections: ' + escapeHtml(e.message || e), { parse_mode: 'HTML', ...mainKeyboard(ctx) });
  }
});

bot.command('reporterror', async (ctx) => {
  pendingErrorReports.add(String(ctx.from.id));
  await ctx.reply('🆘 Send the bot error/problem in your next message. It will be forwarded privately to the owner.', mainKeyboard(ctx));
});

bot.command(['listconn', 'listconnections'], async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply('⛔ This command is only for the owner.');
  const all = (db.listAllConnections && db.listAllConnections()) || db.getConnections() || {};
  const ids = Object.keys(all);
  if (!ids.length) return ctx.reply('No WhatsApp connections yet.');

  let text = '📱 <b>All Connections</b>\n\n';
  let n = 0;
  for (const id of ids) {
    const list = all[id] || [];
    n++;
    const limit = db.getConnLimit(id);
    text += `${n}. TG: <code>${id}</code>\n`;
    text += `   Limit: ${limit} | Connected: <b>${list.length}</b>\n`;
    list.forEach((c, i) => {
      text += `   ${i + 1}) <code>${c.phone || c.sessionId}</code>\n`;
    });
    text += '\n';
  }
  if (text.length > 4000) text = text.slice(0, 3900) + '\n\n…';
  await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command(['setlimit', 'connlimit'], async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply('⛔ This command is only for the owner.');
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  if (!args[0]) {
    const lim = db.getLimits();
    return ctx.reply(
      `Usage:\n` +
      `/setlimit &lt;telegram_id&gt; &lt;max&gt;\n` +
      `/setlimit default &lt;max&gt;\n\n` +
      `Current default: <b>${lim.defaultMax || 1}</b>\n` +
      `Owner: unlimited`,
      { parse_mode: 'HTML' }
    );
  }
  if (args[0].toLowerCase() === 'default') {
    const max = parseInt(args[1], 10) || 1;
    db.setDefaultConnLimit(max);
    return ctx.reply(`✅ Default connection limit set to <b>${max}</b> WhatsApp(s) per user.`, { parse_mode: 'HTML' });
  }
  const targetId = args[0].replace(/\D/g, '');
  const max = parseInt(args[1], 10) || 1;
  db.setConnLimit(targetId, max);
  await ctx.reply(`✅ Limit for <code>${targetId}</code> set to <b>${max}</b> WhatsApp connection(s).`, { parse_mode: 'HTML' });
});


// ==================== SESSION DASHBOARD ====================
function maskPhone(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (p.length < 6) return p || '—';
  return p.slice(0, 4) + '***' + p.slice(-3);
}

function sessionHealth(sessionId) {
  const pair = require('./pair');
  const doctor = require('./core/doctor');
  const sock = pair.getSocket(String(sessionId));
  const st = pair.getSessionStatus(String(sessionId));
  const health = doctor.check(String(sessionId), sock);
  return { st, health, sock };
}

async function buildSessionsDashboard(ctx) {
  const pair = require('./pair');
  const doctor = require('./core/doctor');
  const userId = String(ctx.from.id);
  const plan = isOwner(ctx) ? 'OWNER' : 'FREE';
  let list = db.getUserConnections(ctx.from.id) || [];
  if (isOwner(ctx) && (!list.length)) {
    // owner can still see via listconn; dashboard shows own pairs first
  }
  const max = isOwner(ctx) ? '∞' : (db.getConnLimit ? db.getConnLimit(userId) : list.length || 1);

  // global media probe once
  const sharp = doctor.probeSharp();
  const ffmpeg = doctor.probeFfmpeg();
  const ai = doctor.probeAI();

  let online = 0;
  const rows = [];
  for (const c of list) {
    const id = String(c.sessionId || c.phone || '').replace(/\D/g, '');
    const st = pair.getSessionStatus(id);
    if (st.connected) online++;
    rows.push({ id, st });
  }

  let text =
    `⚡ <b>𝙅𝙄𝙉𝙓 𝙆9 · SESSION DASHBOARD</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>You:</b> ${ctx.from.first_name || 'User'}\n` +
    `🆔 <code>${userId}</code>\n` +
    `📦 <b>Plan:</b> ${plan}\n` +
    `📊 <b>Pairs:</b> ${list.length} / ${max}\n` +
    `🟢 Online: <b>${online}</b>\n\n` +
    `🩺 <b>Host health</b>\n` +
    `${sharp.ok ? '🟢' : '🔴'} sharp — ${sharp.detail}\n` +
    `${ffmpeg.ok ? '🟢' : '🔴'} ffmpeg — ${ffmpeg.detail}\n` +
    `${ai.ok ? '🟢' : '🔴'} AI — ${ai.detail}\n\n`;

  if (!rows.length) {
    text += `📱 No WhatsApp sessions yet.\nUse /connect &lt;number&gt;`;
  } else {
    text += `┌─ <b>YOUR SESSIONS</b>\n`;
    rows.forEach((r, i) => {
      text += `│ ${i + 1}) <code>${r.id}</code>\n`;
      text += `│    ${r.st.connected ? '🟢 ONLINE' : '🔴 OFFLINE'} · ${r.st.runtime || '—'}\n`;
    });
    text += `└─`;
  }

  return { text, keyboard: mainKeyboard(ctx) };
}

async function buildSessionDetail(ctx, sessionId) {
  const pair = require('./pair');
  const doctor = require('./core/doctor');
  const id = String(sessionId).replace(/\D/g, '');
  if (!(await pair.ownsSession(id, String(ctx.from.id)))) {
    return { text: '❌ Session not found or not yours.', keyboard: mainKeyboard(ctx) };
  }
  const { st, health } = sessionHealth(id);
  const text =
    `⚡ <b>SESSION</b> · <code>${id}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Status: ${st.connected ? '🟢 ONLINE' : '🔴 OFFLINE'}\n` +
    `Uptime: ${st.runtime || '—'}\n\n` +
    `┌─ <b>HEALTH (Doctor)</b>\n` +
    `│ ${health.whatsapp ? '🟢' : '🔴'} WhatsApp\n` +
    `│ ${health.session ? '🟢' : '🔴'} Session files\n` +
    `│ ${health.sharp.ok ? '🟢' : '🔴'} sharp — ${health.sharp.detail}\n` +
    `│ ${health.ffmpeg.ok ? '🟢' : '🔴'} ffmpeg — ${health.ffmpeg.detail}\n` +
    `│ ${health.ai.ok ? '🟢' : '🔴'} AI — ${health.ai.detail}\n` +
    `│ 💾 ${health.memory}\n` +
    `│ 🟦 ${health.node}\n` +
    `└─\n\n` +
    `<i>ffmpeg missing → slap/audio FX may fail\nsharp missing → stickers may fail</i>`;

  return { text, keyboard: mainKeyboard(ctx) };
}

bot.command(['sessions', 'dashboard', 'panel'], async (ctx) => {
  try {
    const { text, keyboard } = await buildSessionsDashboard(ctx);
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  } catch (e) {
    await ctx.reply('Dashboard error: ' + (e.message || 'unknown'));
  }
});

bot.action('mx_dash', async (ctx) => {
  try {
    await ctx.answerCbQuery('Refreshing…');
    const { text, keyboard } = await buildSessionsDashboard(ctx);
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  } catch (e) {
    await ctx.answerCbQuery('Failed').catch(() => {});
  }
});

bot.action(['mx_listpair', 'jinx_listpair'], async (ctx) => {
  await ctx.answerCbQuery();
  const conns = db.getUserConnections(ctx.from.id) || [];
  if (!conns.length) return ctx.reply('No pairs. Use /connect');
  let t = '📱 <b>Your pairs</b>\n\n';
  conns.forEach((c, i) => { t += `${i + 1}. <code>${c.phone || c.sessionId}</code>\n`; });
  await ctx.reply(t, { parse_mode: 'HTML' });
});

bot.action('mx_doctor_host', async (ctx) => {
  try {
    const doctor = require('./core/doctor');
    const h = doctor.check(null, null);
    await ctx.answerCbQuery();
    await ctx.reply(doctor.html(h), { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.answerCbQuery('Doctor failed').catch(() => {});
  }
});

bot.action(/^mx_sess:(.+)$/, async (ctx) => {
  try {
    const id = ctx.match[1];
    await ctx.answerCbQuery();
    const { text, keyboard } = await buildSessionDetail(ctx, id);
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  } catch (e) {
    await ctx.answerCbQuery('Error').catch(() => {});
  }
});

bot.action(/^mx_restart:(.+)$/, async (ctx) => {
  try {
    const id = ctx.match[1];
    await ctx.answerCbQuery('Restarting…');
    const pair = require('./pair');
    if (!(await pair.ownsSession(id, String(ctx.from.id)))) {
      return ctx.reply('❌ Not your session.');
    }
    const ok = await pair.restartSession(id, String(ctx.from.id));
    await ctx.reply(ok ? `✅ Restarted <code>${id}</code>` : `❌ Restart failed for <code>${id}</code>`, { parse_mode: 'HTML' });
    const { text, keyboard } = await buildSessionDetail(ctx, id);
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  } catch (e) {
    await ctx.reply('Restart error: ' + (e.message || ''));
  }
});

bot.action(/^mx_del:(.+)$/, async (ctx) => {
  try {
    const id = ctx.match[1];
    await ctx.answerCbQuery('Removing…');
    const pair = require('./pair');
    const ok = await pair.removeSession(id, String(ctx.from.id));
    await ctx.reply(ok ? `✅ Removed <code>${id}</code>` : `❌ Could not remove <code>${id}</code>`, { parse_mode: 'HTML' });
    const { text, keyboard } = await buildSessionsDashboard(ctx);
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  } catch (e) {
    await ctx.reply('Delete error: ' + (e.message || ''));
  }
});

bot.action(/^mx_doctor:(.+)$/, async (ctx) => {
  try {
    const id = ctx.match[1];
    await ctx.answerCbQuery();
    const pair = require('./pair');
    const doctor = require('./core/doctor');
    if (!(await pair.ownsSession(id, String(ctx.from.id)))) {
      return ctx.reply('❌ Not your session.');
    }
    const sock = pair.getSocket(id);
    const h = doctor.check(id, sock);
    await ctx.reply(doctor.html(h), { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply('Doctor error: ' + (e.message || ''));
  }
});

// ==================== 𝙅𝙄𝙉𝙓 𝙆9 CONTROL PANEL ====================

// The control panel is intentionally keyboard-first. The buttons live in
// Telegram's reply keyboard, not inside messages.

async function sendConnectPrompt(ctx) {
  pendingPhoneRequests.add(String(ctx.from.id));
  await ctx.reply(
    `📱 <b>Connect WhatsApp</b>\n\n` +
    `Send your WhatsApp number with country code.\n` +
    `Example: <code>2348123456789</code>\n\n` +
    `Do not include <code>+</code> or spaces.`,
    { parse_mode: 'HTML', ...Markup.forceReply() }
  );
}

async function sendSessions(ctx) {
  try {
    const { text } = await buildSessionsDashboard(ctx);
    await ctx.reply(text, { parse_mode: 'HTML', ...mainKeyboard(ctx) });
  } catch (e) {
    await ctx.reply('❌ Unable to load your sessions right now.', mainKeyboard(ctx));
  }
}

async function sendStatus(ctx) {
  try {
    const pair = require('./pair');
    const list = db.getUserConnections(ctx.from.id) || [];
    let online = 0;
    for (const c of list) {
      if (pair.getSessionStatus(c.sessionId).connected) online++;
    }
    await ctx.reply(
      `🩺 <b>Connection Status</b>\n\n` +
      `🟢 Online: <b>${online}</b>\n` +
      `📱 Total: <b>${list.length}</b>`,
      { parse_mode: 'HTML', ...mainKeyboard(ctx) }
    );
  } catch {
    await ctx.reply('❌ Connection status is temporarily unavailable.', mainKeyboard(ctx));
  }
}

async function sendHelp(ctx) {
  await ctx.reply(
    `ℹ️ <b>𝙅𝙄𝙉𝙓 𝙆9</b>\n\n` +
    `WhatsApp multi-session control panel.\n\n` +
    `🔗 <b>Connect WhatsApp</b> — link a WhatsApp number.\n` +
    `📱 <b>My Sessions</b> — view and manage your sessions.\n` +
    `📋 <b>My Numbers</b> — view your connected numbers.\n` +
    `🩺 <b>Status</b> — check connection status.\n\n` +
    `🟢 <b>Access:</b> FREE for everyone.`,
    { parse_mode: 'HTML', ...mainKeyboard(ctx) }
  );
}

bot.hears('🆘 Report Error', async (ctx) => {
  pendingErrorReports.add(String(ctx.from.id));
  await ctx.reply('🆘 <b>Report an Error</b>\n\nDescribe exactly what is not working, including any error message you see.\n\nYour report will be sent privately to the bot owner.', { parse_mode: 'HTML', ...mainKeyboard(ctx) });
});

bot.hears('👑 All Connections', async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply('⛔ Owner only.');
  try {
    const text = await buildAllConnectionsDashboard();
    await replyLongHtml(ctx, text, mainKeyboard(ctx));
  } catch (e) {
    await ctx.reply('❌ Could not load connections.', mainKeyboard(ctx));
  }
});

bot.hears('📢 Broadcast', async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply('⛔ Owner only.');
  pendingBroadcasts.add(String(ctx.from.id));
  await ctx.reply('📢 Send the message you want to broadcast to all Telegram users who have opened this bot.', mainKeyboard(ctx));
});

bot.hears('🔗 Connect WhatsApp', async (ctx) => {
  await sendConnectPrompt(ctx);
});

bot.hears('📱 My Sessions', async (ctx) => {
  await sendSessions(ctx);
});

bot.hears('📋 My Numbers', async (ctx) => {
  const conns = db.getUserConnections(ctx.from.id) || [];
  if (!conns.length) {
    return ctx.reply(
      `📋 <b>My Numbers</b>\n\nNo WhatsApp numbers are connected yet.\n\nTap <b>🔗 Connect WhatsApp</b> below to add one.`,
      { parse_mode: 'HTML', ...mainKeyboard(ctx) }
    );
  }
  let text = `📋 <b>My Numbers</b>\n\n`;
  conns.forEach((c, i) => {
    text += `${i + 1}. <code>${escapeHtml(c.phone || c.sessionId)}</code>\n`;
  });
  await ctx.reply(text, { parse_mode: 'HTML', ...mainKeyboard(ctx) });
});

bot.hears('🩺 Status', async (ctx) => {
  await sendStatus(ctx);
});

bot.hears('ℹ️ Help', async (ctx) => {
  await sendHelp(ctx);
});

// Backwards-compatible slash commands remain functional, but the main UI does
// not require users to type them.
bot.command('connect', async (ctx) => {
  const args = (ctx.message.text || '').trim().split(/\s+/).slice(1);
  const phoneArg = (args[0] || '').replace(/\D/g, '');

  if (phoneArg && phoneArg.length >= 10 && phoneArg.length <= 15) {
    await startPairFlow(ctx, phoneArg);
    return;
  }

  await sendConnectPrompt(ctx);
});

// ==================== LAUNCH ====================
async function startTelegramBot() {
  if (!BOT_TOKEN || BOT_TOKEN.length < 20 || !BOT_TOKEN.includes(':')) {
    console.error(chalk.red('❌ Invalid or missing BOT_TOKEN. Set BOT_TOKEN in config.env or the hosting environment'));
    throw new Error('BOT_TOKEN is missing or invalid');
  }
  try {
    await registerBotCommands();
    await bot.launch({ dropPendingUpdates: true });
    console.log(chalk.green('✅ Telegram bot started successfully'));
  } catch (e) {
    console.error(chalk.red('❌ Failed to start Telegram bot:'), e.message);
    if (/401|Unauthorized/i.test(String(e.message || e))) {
      console.error(chalk.red('   → Token is invalid or revoked. Update BOT_TOKEN and restart.'));
    }
    throw e;
  }
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = { bot, startTelegramBot };
