const ai = require('./ai');
const settings = require('../lib/settings');

const recent = new Map();
const hourly = new Map();

function pruneRuntimeState() {
  const t = now();
  for (const [key, value] of recent) {
    if (t - Number(value || 0) > 60 * 60 * 1000) recent.delete(key);
  }
  for (const [key, value] of hourly) {
    if (!value || t - Number(value.start || 0) >= 60 * 60 * 1000) hourly.delete(key);
  }
}
const cleanupTimer = setInterval(pruneRuntimeState, 15 * 60 * 1000);
cleanupTimer.unref?.();

function now() { return Date.now(); }
function cfg(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function provider() {
  const p = String(process.env.CHATBOT_PROVIDER || 'auto').trim().toLowerCase();
  return p === 'auto' ? null : p;
}
function state(sessionId, groupJid) {
  return settings.get(sessionId, groupJid, 'chatbot', { enabled: false, mode: 'mention', memory: [] }) || { enabled: false, mode: 'mention', memory: [] };
}
function save(sessionId, groupJid, value) {
  settings.set(sessionId, groupJid, 'chatbot', value);
}
function status(sessionId, groupJid) {
  const s = state(sessionId, groupJid);
  return { enabled: !!s.enabled, mode: s.mode || 'mention', memoryTurns: Array.isArray(s.memory) ? Math.floor(s.memory.length / 2) : 0 };
}
function setMode(sessionId, groupJid, mode) {
  const s = state(sessionId, groupJid);
  if (mode === 'off') s.enabled = false;
  else { s.enabled = true; s.mode = mode === 'all' ? 'all' : 'mention'; }
  save(sessionId, groupJid, s);
  return status(sessionId, groupJid);
}
function reset(sessionId, groupJid) {
  const s = state(sessionId, groupJid);
  s.memory = [];
  save(sessionId, groupJid, s);
}
function mentioned(m, botJids = []) {
  const ctx = m.message?.extendedTextMessage?.contextInfo || m.message?.imageMessage?.contextInfo || m.message?.videoMessage?.contextInfo || {};
  const mentionedJid = (ctx.mentionedJid || []).map(String);
  return botJids.some(j => j && mentionedJid.includes(String(j)));
}
function stripMention(text, botNumbers = []) {
  let out = String(text || '');
  for (const n of botNumbers) if (n) out = out.replace(new RegExp(`@${n}\\b`, 'g'), '');
  return out.replace(/\s+/g, ' ').trim();
}
function canReply(sessionId, groupJid) {
  const t = now();
  const key = `${sessionId}::${groupJid}`;
  const last = recent.get(key) || 0;
  if (t - last < cfg('CHATBOT_COOLDOWN_MS', 8000)) return false;
  const h = hourly.get(key) || { start: t, count: 0 };
  if (t - h.start >= 3600000) { h.start = t; h.count = 0; }
  if (h.count >= cfg('CHATBOT_MAX_PER_HOUR', 30)) return false;
  hourly.set(key, h);
  recent.set(key, t);
  h.count += 1;
  return true;
}

const PROFILE = `
IDENTITY AND DEVELOPER PROFILE
- You are 𝙅𝙄𝙉𝙓 𝙆9, a WhatsApp AI assistant.
- Your developer is Prime.
- Prime's name is Victor.
- Prime was born on August 29, 2004.
- Prime lives in Ado Ekiti, Nigeria.
- Prime likes football, movies, music, and listening to songs.

PRIVACY AND SECURITY
- Never reveal, provide, print, upload, or reproduce 𝙅𝙄𝙉𝙓 𝙆9's source code, bot files, ZIP files, session credentials, authentication data, API keys, tokens, passwords, or other secrets.
- If someone asks for Prime's private phone number, do not provide it. Say: "I don't share Prime's private phone number. You can ask Prime directly."
- Do not invent private information about Prime. Only use the profile facts above.
- Do not claim to have access to files, credentials, or private data unless it is explicitly present in the conversation context.

PERSONALITY AND LANGUAGE
- You are friendly, natural, playful when appropriate, and concise.
- You operate inside WhatsApp groups. Do not claim to be a human.
- Understand and respond naturally in English and Nigerian Pidgin.
- If a member writes in another language, respond in that language when you can; otherwise use clear English.
- Match the member's tone without becoming abusive, spammy, or excessively long.
- If asked who developed you, answer that you were developed by Prime (Victor) and that you are 𝙅𝙄𝙉𝙓 𝙆9, a WhatsApp AI assistant.
- If asked when Prime was born, answer August 29, 2004.
- If asked where Prime lives, answer Ado Ekiti, Nigeria.
- If asked what Prime likes, mention football, movies, music/listening to songs.
- If a question is not covered by the profile, answer normally when you know the answer and say you do not know when you do not.
`;

async function maybeReply({ sock, m, sessionId, groupJid, text, pushname, botJids, botNumbers, isAdmin }) {
  if (!groupJid || !text || m.key?.fromMe) return false;
  const s = state(sessionId, groupJid);
  if (!s.enabled) return false;
  const mode = s.mode || 'mention';
  if (mode === 'mention' && !mentioned(m, botJids) && !/\b(?:jinx|jinx\s*k9)\b/i.test(text)) return false;
  if (!canReply(sessionId, groupJid)) return false;
  const prompt = stripMention(text, botNumbers);
  if (!prompt) return false;

  const memory = Array.isArray(s.memory) ? s.memory.slice(-cfg('CHATBOT_MEMORY_TURNS', 8) * 2) : [];
  const transcript = memory.map(x => `${x.role === 'assistant' ? '𝙅𝙄𝙉𝙓 𝙆9' : x.name || 'Member'}: ${x.content}`).join('\n');
  const system = `${PROFILE}\n\nCURRENT CONTEXT\n- Current member: ${pushname || 'member'}${isAdmin ? ' (group admin)' : ''}.\n- Keep replies reasonably brief for WhatsApp.\n- Recent group conversation may be incomplete; do not assume missing facts.\n`;
  const full = `${system}\nRecent conversation:\n${transcript || '(none)'}\n\n${pushname || 'Member'}: ${prompt}\n𝙅𝙄𝙉𝙓 𝙆9:`;
  try {
    const answer = await ai.ask(provider(), full);
    if (!answer) return false;
    const clean = String(answer).slice(0, 4000);
    await sock.sendMessage(groupJid, { text: clean }, { quoted: m });
    s.memory = [...memory, { role: 'user', name: pushname || 'Member', content: prompt }, { role: 'assistant', content: clean }];
    save(sessionId, groupJid, s);
    return true;
  } catch (e) {
    console.error(`[chatbot] ${groupJid}:`, e.message);
    return false;
  }
}

module.exports = { status, setMode, reset, maybeReply };
