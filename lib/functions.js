const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTime(ms) {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h ${min % 60}m ${sec % 60}s`;
}

function runtime(startedAt = null) {
  const start = Number(startedAt);
  if (Number.isFinite(start) && start > 0) {
    return formatTime(Math.max(0, Date.now() - start));
  }
  return formatTime(process.uptime() * 1000);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandom(ext = '') {
  return `${Math.floor(Math.random() * 1000000)}${ext}`;
}

async function fetchBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(res.data);
}

async function getBuffer(url) {
  try {
    return await fetchBuffer(url);
  } catch {
    return null;
  }
}

function parseMention(text = '') {
  return [...text.matchAll(/@([0-9]{5,16})/g)].map(v => v[1] + '@s.whatsapp.net');
}

function isUrl(text) {
  const value = String(text || '');
  // Detect ordinary URLs, common short-link services and bare domains.
  // The bare-domain branch intentionally treats any valid-looking TLD as a
  // link because the group antilink feature is designed to block external
  // links, not only chat.whatsapp.com invitations.
  const externalLinkRegex = /(?:https?:\/\/|www\.|(?:wa\.me|t\.me|bit\.ly)\/|(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b)/i;
  return externalLinkRegex.test(value);
}

function getGroupAdmins(participants = []) {
  const admins = [];
  for (const p of participants || []) {
    if (p.admin === 'admin' || p.admin === 'superadmin') {
      for (const k of [p.id, p.jid, p.phoneNumber, p.lid]) {
        if (k) admins.push(String(k));
      }
    }
  }
  return admins;
}

function sameId(a, b) {
  if (!a || !b) return false;
  const na = String(a).split(':')[0].replace(/[^0-9]/g, '');
  const nb = String(b).split(':')[0].replace(/[^0-9]/g, '');
  if (na && nb && na === nb) return true;
  return String(a) === String(b);
}

function listHasId(list, ...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    for (const item of list || []) {
      if (sameId(item, c)) return true;
    }
  }
  return false;
}


async function downloadMediaMessage(msg, type = 'buffer') {
  // Simple placeholder - real implementation uses Baileys downloadContentFromMessage
  return null;
}

/**
 * Safe arithmetic evaluator — no Function()/eval.
 * Supports + - * / % and parentheses. Rejects everything else.
 */
function safeCalc(input) {
  const raw = String(input || '').replace(/\s+/g, '');
  if (!raw) throw new Error('Empty expression');
  if (raw.length > 120) throw new Error('Expression too long');
  if (!/^[0-9+\-*/().%]+$/.test(raw)) throw new Error('Invalid characters');

  let i = 0;
  function peek() { return raw[i]; }
  function next() { return raw[i++]; }

  function parseNumber() {
    let start = i;
    if (peek() === '+' || peek() === '-') next();
    while (peek() && /[0-9.]/.test(peek())) next();
    const n = Number(raw.slice(start, i));
    if (!Number.isFinite(n)) throw new Error('Invalid number');
    return n;
  }

  function parseFactor() {
    if (peek() === '(') {
      next();
      const v = parseExpr();
      if (peek() !== ')') throw new Error('Missing )');
      next();
      return v;
    }
    return parseNumber();
  }

  function parseTerm() {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      const r = parseFactor();
      if (op === '*') v *= r;
      else if (op === '/') {
        if (r === 0) throw new Error('Division by zero');
        v /= r;
      } else {
        if (r === 0) throw new Error('Modulo by zero');
        v %= r;
      }
    }
    return v;
  }

  function parseExpr() {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  const result = parseExpr();
  if (i !== raw.length) throw new Error('Unexpected trailing input');
  if (!Number.isFinite(result)) throw new Error('Non-finite result');
  // Avoid noisy float artifacts for common cases
  const rounded = Math.round(result * 1e12) / 1e12;
  return rounded;
}

module.exports = {
  sleep,
  formatTime,
  runtime,
  pickRandom,
  getRandom,
  fetchBuffer,
  getBuffer,
  parseMention,
  isUrl,
  getGroupAdmins,
  sameId,
  listHasId,
  downloadMediaMessage,
  safeCalc
};
