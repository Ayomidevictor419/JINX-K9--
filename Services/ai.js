/**
 * 𝙅𝙄𝙉𝙓 𝙆9 AI engine — free public gateways first.
 * No personal API keys required.
 * Optional keys still used if present in env.
 */
require('../lib/env').loadEnvFile();
const axios = require('axios');

function key(name) {
  return String(process.env[name] || '').trim();
}
function model(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

const UA = {
  'User-Agent': 'Jinx-K9-MD/1.0',
  'Content-Type': 'application/json',
  Accept: 'application/json'
};

const SYSTEM = 'You are 𝙅𝙄𝙉𝙓 𝙆9, a helpful WhatsApp AI assistant. Keep answers clear, friendly, and concise.';

function extractText(data) {
  if (!data) return null;
  if (typeof data === 'string') {
    const t = data.trim();
    if (!t) return null;
    if (t.startsWith('{')) {
      try { return extractText(JSON.parse(t)); } catch (e) { return t; }
    }
    return t;
  }
  const choice = data?.choices?.[0];
  const msg =
    choice?.message?.content ||
    choice?.text ||
    data?.response ||
    data?.result ||
    data?.output ||
    data?.text ||
    data?.message;
  if (Array.isArray(msg)) {
    return msg.map(x => (typeof x === 'string' ? x : x?.text || '')).join('').trim() || null;
  }
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map(p => p?.text || '').join('').trim();
    if (t) return t;
  }
  return null;
}

function isBudgetError(err) {
  const s = String(err?.message || err || '').toLowerCase();
  return (
    s.includes('budget') ||
    s.includes('rate limit') ||
    s.includes('rate-limited') ||
    s.includes('too many requests') ||
    s.includes('quota') ||
    s.includes('429')
  );
}

async function postChat(url, body, headers = {}) {
  const r = await axios.post(url, body, {
    timeout: 45000,
    headers: { ...UA, ...headers },
    validateStatus: s => s < 500
  });
  if (r.status >= 400) {
    const detail = r.data?.error?.message || r.data?.error || r.statusText || `HTTP ${r.status}`;
    throw new Error(String(detail));
  }
  const text = extractText(r.data);
  if (!text) throw new Error('Empty AI response');
  // Treat provider budget messages as failures so fallback continues
  if (/reached its budget|raise the key budget|topping up the wallet/i.test(text)) {
    throw new Error(text);
  }
  return text;
}

async function getText(url) {
  const r = await axios.get(url, {
    timeout: 45000,
    headers: { 'User-Agent': 'Jinx-K9-MD/1.0', Accept: 'text/plain, application/json' },
    responseType: 'text',
    validateStatus: s => s < 500,
    transformResponse: [d => d]
  });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  let data = r.data;
  try {
    if (typeof data === 'string' && data.trim().startsWith('{')) data = JSON.parse(data);
  } catch (e) {}
  const text = extractText(data) || (typeof data === 'string' ? data.trim() : null);
  if (!text) throw new Error('Empty AI response');
  if (/reached its budget|raise the key budget|topping up the wallet/i.test(text)) {
    throw new Error(text);
  }
  return text;
}

/* ---------- Free public gateways (no personal key) ---------- */

async function freePollinationsOpenAI(prompt, modelName = 'openai') {
  return await postChat('https://text.pollinations.ai/openai', {
    model: modelName || 'openai',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt }
    ]
  });
}

async function freePollinationsGen(prompt, modelName = 'openai') {
  return await postChat('https://gen.pollinations.ai/v1/chat/completions', {
    model: modelName || 'openai',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt }
    ]
  });
}

async function freePollinationsGet(prompt, modelName = 'openai') {
  const url =
    `https://text.pollinations.ai/${encodeURIComponent(prompt.slice(0, 1500))}` +
    `?model=${encodeURIComponent(modelName || 'openai')}`;
  return await getText(url);
}

async function freeDgAi(prompt, pathModel = 'gpt-oss') {
  try {
    return await postChat(`https://dg-ai.scriptsnsenses.workers.dev/v1/chat/${encodeURIComponent(pathModel)}`, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt }
      ]
    });
  } catch (e) {
    return await postChat('https://dg-ai.scriptsnsenses.workers.dev/v1/chat/completions', {
      model: pathModel,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt }
      ]
    });
  }
}

async function freeGenericOpenAI(baseUrl, prompt, modelName, apiKey = '') {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  return await postChat(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    model: modelName,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt }
    ]
  }, headers);
}

/* ---------- Optional official keys (only if user already has them) ---------- */

async function openaiOfficial(prompt) {
  const k = key('OPENAI_API_KEY');
  if (!k) throw new Error('OPENAI_API_KEY not set');
  return freeGenericOpenAI('https://api.openai.com/v1', prompt, model('OPENAI_MODEL', 'gpt-4o-mini'), k);
}

async function geminiOfficial(prompt) {
  const k = key('GEMINI_API_KEY');
  if (!k) throw new Error('GEMINI_API_KEY not set');
  const m = model('GEMINI_MODEL', 'gemini-2.0-flash');
  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(k)}`,
    { contents: [{ parts: [{ text: prompt }] }] },
    { timeout: 45000, headers: UA, validateStatus: s => s < 500 }
  );
  if (r.status >= 400) throw new Error(r.data?.error?.message || `HTTP ${r.status}`);
  const text = extractText(r.data);
  if (!text) throw new Error('Empty Gemini response');
  return text;
}

async function deepseekOfficial(prompt) {
  const k = key('DEEPSEEK_API_KEY');
  if (!k) throw new Error('DEEPSEEK_API_KEY not set');
  return freeGenericOpenAI('https://api.deepseek.com', prompt, model('DEEPSEEK_MODEL', 'deepseek-chat'), k);
}

async function mistralOfficial(prompt) {
  const k = key('MISTRAL_API_KEY');
  if (!k) throw new Error('MISTRAL_API_KEY not set');
  return freeGenericOpenAI('https://api.mistral.ai/v1', prompt, model('MISTRAL_MODEL', 'mistral-small-latest'), k);
}

async function groqOfficial(prompt) {
  const k = key('GROQ_API_KEY');
  if (!k) throw new Error('GROQ_API_KEY not set');
  return freeGenericOpenAI('https://api.groq.com/openai/v1', prompt, model('GROQ_MODEL', 'llama-3.3-70b-versatile'), k);
}

async function openrouterOfficial(prompt) {
  const k = key('OPENROUTER_API_KEY');
  if (!k) throw new Error('OPENROUTER_API_KEY not set');
  return freeGenericOpenAI(
    'https://openrouter.ai/api/v1',
    prompt,
    model('OPENROUTER_MODEL', 'openrouter/auto'),
    k
  );
}

/* ---------- Free chain (no key) ---------- */

async function runFreeChain(prompt) {
  const attempts = [
    () => freeDgAi(prompt, 'gpt-oss'),
    () => freeDgAi(prompt, 'gpt-oss-120b'),
    () => freePollinationsGen(prompt, 'openai'),
    () => freePollinationsOpenAI(prompt, 'openai'),
    () => freePollinationsGet(prompt, 'openai'),
    () => freePollinationsOpenAI(prompt, 'openai-large'),
    () => freePollinationsGen(prompt, 'mistral'),
    () => freePollinationsGet(prompt, 'mistral'),
    () => freeDgAi(prompt, 'qwen-2.5-32b'),
    () => freeDgAi(prompt, 'llama')
  ];

  const failures = [];
  for (const fn of attempts) {
    try {
      const text = await fn();
      if (text && String(text).trim()) return String(text).trim();
    } catch (e) {
      failures.push(String(e.message || e).slice(0, 120));
    }
  }
  throw new Error(
    'Free AI is busy right now. All public routes failed.\n' +
    'Try again in a few minutes.'
  );
}

/* ---------- Named providers ---------- */

async function openai(prompt) {
  if (key('OPENAI_API_KEY')) {
    try { return await openaiOfficial(prompt); } catch (e) {}
  }
  if (key('GROQ_API_KEY')) {
    try { return await groqOfficial(prompt); } catch (e) {}
  }
  if (key('OPENROUTER_API_KEY')) {
    try { return await openrouterOfficial(prompt); } catch (e) {}
  }
  return await runFreeChain(prompt);
}

async function gemini(prompt) {
  if (key('GEMINI_API_KEY')) {
    try { return await geminiOfficial(prompt); } catch (e) {}
  }
  return await runFreeChain(prompt);
}

async function deepseek(prompt) {
  if (key('DEEPSEEK_API_KEY')) {
    try { return await deepseekOfficial(prompt); } catch (e) {}
  }
  return await runFreeChain(prompt);
}

async function mistral(prompt) {
  if (key('MISTRAL_API_KEY')) {
    try { return await mistralOfficial(prompt); } catch (e) {}
  }
  return await runFreeChain(prompt);
}

async function llama(prompt) {
  try { return await freeDgAi(prompt, 'llama'); } catch (e) {}
  return await runFreeChain(prompt);
}

async function coder(prompt) {
  try { return await freeDgAi(prompt, 'qwen-2.5-32b'); } catch (e) {}
  return await runFreeChain(prompt);
}

async function pollinations(prompt) {
  try { return await freePollinationsGen(prompt, 'openai'); } catch (e) {}
  try { return await freePollinationsOpenAI(prompt, 'openai'); } catch (e) {}
  return await freePollinationsGet(prompt, 'openai');
}

const PROVIDERS = {
  openai,
  gpt: openai,
  gemini,
  deepseek,
  mistral,
  llama,
  coder,
  pollinations,
  polli: pollinations
};

function configuredProviders() {
  return ['openai', 'gemini', 'deepseek', 'mistral', 'llama', 'pollinations'];
}

function providerError(name, err) {
  const detail = err?.response?.data?.error?.message || err?.message || String(err);
  if (isBudgetError(err) || /budget|quota|rate limit/i.test(String(detail))) {
    return 'Free AI route is busy / limited. Trying other routes or try again shortly.';
  }
  return `${name} error: ${String(detail).slice(0, 180)}`;
}

async function callNamed(name, prompt) {
  const fn = PROVIDERS[name];
  if (!fn) throw new Error(`Unknown AI provider: ${name}`);
  try {
    return await fn(prompt);
  } catch (err) {
    err.userMessage = providerError(name.toUpperCase(), err);
    throw err;
  }
}

/**
 * Central engine:
 * - named provider if requested
 * - otherwise free public gateway chain (no key needed)
 */
async function ask(provider, prompt) {
  const p = String(prompt || '').trim();
  if (!p) throw new Error('Empty prompt');

  if (provider && provider !== 'auto' && PROVIDERS[provider]) {
    try {
      return await callNamed(provider, p);
    } catch (err) {
      try {
        return await runFreeChain(p);
      } catch (e2) {
        throw new Error(err.userMessage || err.message || String(err));
      }
    }
  }

  // .ai auto mode — free public routes first
  try {
    return await runFreeChain(p);
  } catch (e) {
    const official = [];
    if (key('GROQ_API_KEY')) official.push(() => groqOfficial(p));
    if (key('GEMINI_API_KEY')) official.push(() => geminiOfficial(p));
    if (key('OPENROUTER_API_KEY')) official.push(() => openrouterOfficial(p));
    if (key('OPENAI_API_KEY')) official.push(() => openaiOfficial(p));
    if (key('DEEPSEEK_API_KEY')) official.push(() => deepseekOfficial(p));
    if (key('MISTRAL_API_KEY')) official.push(() => mistralOfficial(p));
    for (const fn of official) {
      try { return await fn(); } catch (err) {}
    }
    throw new Error('Free AI is busy right now. Please try again in a few minutes.');
  }
}

module.exports = {
  ask,
  configuredProviders,
  providerError,
  PROVIDERS
};
