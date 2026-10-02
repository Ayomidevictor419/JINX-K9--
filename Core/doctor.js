const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('./runtime');
const registry = require('./registry');

function probeSharp() {
  try {
    require('sharp');
    return { ok: true, detail: 'loaded' };
  } catch (e) {
    return { ok: false, detail: (e && e.message) ? e.message.split('\n')[0].slice(0, 80) : 'missing' };
  }
}

function probeFfmpeg() {
  try {
    let bin = null;
    try { bin = require('ffmpeg-static'); } catch {}
    if (bin && fs.existsSync(bin)) {
      const r = spawnSync(bin, ['-version'], { timeout: 5000, encoding: 'utf8' });
      if (r.status === 0) return { ok: true, detail: 'ffmpeg-static' };
    }
  } catch {}
  try {
    const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000, encoding: 'utf8' });
    if (r.status === 0) return { ok: true, detail: 'system ffmpeg' };
  } catch {}
  return { ok: false, detail: 'not found (sticker GIF/audio FX limited)' };
}

function probeAI() {
  try {
    const ai = require('../services/ai');
    if (typeof ai.chat === 'function' || typeof ai.ask === 'function' || typeof ai.generate === 'function') {
      return { ok: true, detail: 'gateway loaded' };
    }
    return { ok: true, detail: 'module ok' };
  } catch (e) {
    return { ok: false, detail: 'ai module error' };
  }
}

function botVersion() {
  try {
    return require('../config').VERSION || 'unknown';
  } catch {
    return 'unknown';
  }
}

function check(sessionId, sock) {
  const mem = process.memoryUsage();
  const sessionPath = path.resolve('./sessions', String(sessionId || ''));
  const sharp = probeSharp();
  const ffmpeg = probeFfmpeg();
  const ai = probeAI();
  let openSockets = 0;
  try {
    const pair = require('../pair');
    openSockets = pair.sockets ? pair.sockets.size : 0;
  } catch {}
  return {
    matrix: true,
    version: botVersion(),
    whatsapp: !!sock?.user,
    database: fs.existsSync(path.resolve('./database')),
    session: !!(sessionId && fs.existsSync(path.join(sessionPath, 'creds.json'))),
    commands: registry.all().length,
    runtime: sessionId ? runtime.display(sessionId) : 'n/a',
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    memory: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
    sharp,
    ffmpeg,
    ai,
    sessionId: sessionId ? String(sessionId) : null,
    sockets: openSockets
  };
}

function text(result) {
  const line = (ok, label, value) => `${ok ? '🟢' : '🔴'} ${label} ➤ ${value}`;
  return (
    `🩺 *𝙅𝙄𝙉𝙓 𝙆9 DOCTOR*\n\n` +
    line(result.matrix, 'Core', 'ONLINE') + '\n' +
    `🏷 Version ➤ ${result.version || 'n/a'}\n` +
    line(result.whatsapp, 'WhatsApp', result.whatsapp ? 'CONNECTED' : 'DISCONNECTED') + '\n' +
    line(result.database, 'Database', result.database ? 'READY' : 'MISSING') + '\n' +
    line(result.session, 'Session', result.session ? 'READY' : 'MISSING') + '\n' +
    line(result.commands > 0, 'Commands', String(result.commands)) + '\n' +
    line(true, 'Open sockets', String(result.sockets ?? 0)) + '\n' +
    line(result.sharp.ok, 'sharp', result.sharp.ok ? result.sharp.detail : result.sharp.detail) + '\n' +
    line(result.ffmpeg.ok, 'ffmpeg', result.ffmpeg.ok ? result.ffmpeg.detail : result.ffmpeg.detail) + '\n' +
    line(result.ai.ok, 'AI gateway', result.ai.detail) + '\n' +
    `⏱️ Runtime ➤ ${result.runtime}\n` +
    `🟦 Node ➤ ${result.node}\n` +
    `🖥️ Platform ➤ ${result.platform}\n` +
    `💾 Memory ➤ ${result.memory}`
  );
}

function html(result) {
  const line = (ok, label, value) => `${ok ? '🟢' : '🔴'} <b>${label}</b> — ${escapeHtml(String(value))}`;
  return (
    `🩺 <b>𝙅𝙄𝙉𝙓 𝙆9 DOCTOR</b>\n\n` +
    line(result.matrix, 'Core', 'ONLINE') + '\n' +
    `🏷 Version — ${escapeHtml(result.version || 'n/a')}\n` +
    line(result.whatsapp, 'WhatsApp', result.whatsapp ? 'CONNECTED' : 'DISCONNECTED') + '\n' +
    line(result.database, 'Database', result.database ? 'READY' : 'MISSING') + '\n' +
    line(result.session, 'Session', result.session ? 'READY' : 'MISSING') + '\n' +
    line(result.commands > 0, 'Commands', result.commands) + '\n' +
    line(true, 'Open sockets', result.sockets ?? 0) + '\n' +
    line(result.sharp.ok, 'sharp (stickers)', result.sharp.detail) + '\n' +
    line(result.ffmpeg.ok, 'ffmpeg (video/audio)', result.ffmpeg.detail) + '\n' +
    line(result.ai.ok, 'AI gateway', result.ai.detail) + '\n' +
    `⏱ Runtime — ${escapeHtml(result.runtime)}\n` +
    `🟦 Node — ${escapeHtml(result.node)}\n` +
    `🖥 Platform — ${escapeHtml(result.platform)}\n` +
    `💾 Memory — ${escapeHtml(result.memory)}`
  );
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { check, text, html, probeSharp, probeFfmpeg, probeAI };
