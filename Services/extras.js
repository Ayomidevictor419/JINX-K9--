/**
 * Extra helpers for lyrics, wallpaper, reminders, Spotify-ish lookup.
 */
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

const REMIND_FILE = path.resolve('./database/reminders.json');
const reminders = new Map(); // id -> { timer, ... }

function loadReminders() {
  try {
    if (!fs.existsSync(REMIND_FILE)) return;
    const list = fs.readJsonSync(REMIND_FILE);
    if (!Array.isArray(list)) return;
    const now = Date.now();
    for (const r of list) {
      if (!r?.id || !r.when || r.when <= now) continue;
      scheduleReminder(r, false);
    }
  } catch (e) {
    console.error('[remind] load failed:', e.message);
  }
}

function saveReminders() {
  try {
    fs.ensureDirSync(path.dirname(REMIND_FILE));
    const list = [...reminders.values()].map(({ timer, ...rest }) => rest);
    fs.writeJsonSync(REMIND_FILE, list);
  } catch (e) {
    console.error('[remind] save failed:', e.message);
  }
}

function scheduleReminder(r, persist = true) {
  const delay = Math.max(0, Number(r.when) - Date.now());
  if (delay > 2147483647) return false; // setTimeout max ~24.8 days
  const timer = setTimeout(async () => {
    reminders.delete(r.id);
    saveReminders();
    try {
      const pair = require('../pair');
      const sock = pair.getSocket(r.sessionId);
      if (!sock) return;
      await sock.sendMessage(r.chatId, {
        text:
          `⏰ *Reminder*\n` +
          `━━━━━━━━━━━━\n` +
          `${r.text}\n` +
          `━━━━━━━━━━━━\n` +
          (r.createdBy ? `_Set by_ @${String(r.createdBy).split('@')[0]}` : ''),
        mentions: r.createdBy ? [r.createdBy] : []
      });
    } catch (e) {
      console.error('[remind] deliver failed:', e.message);
    }
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  reminders.set(r.id, { ...r, timer });
  if (persist) saveReminders();
  return true;
}

function parseDuration(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 'm').toLowerCase();
  const mult =
    /^(s|sec|secs|second|seconds)$/.test(unit) ? 1000 :
    /^(h|hr|hrs|hour|hours)$/.test(unit) ? 3600000 :
    /^(d|day|days)$/.test(unit) ? 86400000 :
    60000; // default minutes
  const ms = Math.floor(n * mult);
  if (ms < 5000) return null; // min 5s
  if (ms > 7 * 86400000) return null; // max 7 days
  return ms;
}

function addReminder({ sessionId, chatId, createdBy, text, ms }) {
  const id = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const r = {
    id,
    sessionId: String(sessionId),
    chatId: String(chatId),
    createdBy: createdBy ? String(createdBy) : null,
    text: String(text || 'Reminder').slice(0, 500),
    when: Date.now() + ms,
    createdAt: Date.now()
  };
  if (!scheduleReminder(r, true)) throw new Error('Could not schedule reminder');
  return r;
}

function listReminders(sessionId, chatId) {
  return [...reminders.values()]
    .filter((r) => r.sessionId === String(sessionId) && r.chatId === String(chatId))
    .map(({ timer, ...rest }) => rest)
    .sort((a, b) => a.when - b.when);
}

async function fetchLyrics(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Empty query');

  // Try lyrics.ovh suggest + lyrics
  try {
    const sug = await axios.get(`https://api.lyrics.ovh/suggest/${encodeURIComponent(q)}`, { timeout: 12000 });
    const hit = sug.data?.data?.[0];
    if (hit?.artist?.name && hit?.title) {
      const lyr = await axios.get(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(hit.artist.name)}/${encodeURIComponent(hit.title)}`,
        { timeout: 15000 }
      );
      if (lyr.data?.lyrics) {
        return {
          title: hit.title,
          artist: hit.artist.name,
          lyrics: String(lyr.data.lyrics).trim()
        };
      }
    }
  } catch (_) {}

  // Fallback: some public lyric mirrors accept "artist - title" or free text poorly;
  // try splitting "artist - title"
  const parts = q.split(/\s+-\s+|\s+by\s+/i);
  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const title = parts.slice(1).join(' - ').trim();
    try {
      const lyr = await axios.get(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
        { timeout: 15000 }
      );
      if (lyr.data?.lyrics) {
        return { title, artist, lyrics: String(lyr.data.lyrics).trim() };
      }
    } catch (_) {}
  }

  throw new Error('Lyrics not found');
}

async function fetchWallpaper(query = '') {
  const q = String(query || '').trim();
  // Wallhaven public search (no key needed for basic)
  try {
    const params = {
      q: q || 'nature',
      categories: '100',
      purity: '100',
      sorting: q ? 'relevance' : 'random',
      atleast: '1920x1080',
      ratios: '16x9',
      page: '1'
    };
    const { data } = await axios.get('https://wallhaven.cc/api/v1/search', {
      params,
      timeout: 15000,
      headers: { 'User-Agent': 'Jinx-K9/1.3.8' }
    });
    const list = data?.data || [];
    if (list.length) {
      const pick = list[Math.floor(Math.random() * Math.min(list.length, 12))];
      const url = pick?.path || pick?.thumbs?.large;
      if (url) {
        return {
          url,
          resolution: pick.resolution || '',
          source: 'wallhaven',
          page: pick.url || ''
        };
      }
    }
  } catch (_) {}

  // Fallback: picsum random
  const id = Math.floor(Math.random() * 1000);
  return {
    url: `https://picsum.photos/seed/jinx${id}/1080/1920`,
    resolution: '1080x1920',
    source: 'picsum',
    page: ''
  };
}

function parseSpotifyInput(input) {
  const s = String(input || '').trim();
  const track = s.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/i);
  if (track) return { type: 'track', id: track[1], query: null };
  // Use free text as search query (Spotify oEmbed / name search via YT)
  return { type: 'search', id: null, query: s };
}

async function resolveSpotifyToQuery(input) {
  const parsed = parseSpotifyInput(input);
  if (parsed.type === 'search') return parsed.query;

  // Spotify oEmbed gives title without API key
  try {
    const url = `https://open.spotify.com/track/${parsed.id}`;
    const { data } = await axios.get('https://open.spotify.com/oembed', {
      params: { url },
      timeout: 12000,
      headers: { 'User-Agent': 'Jinx-K9/1.3.8' }
    });
    if (data?.title) return String(data.title);
  } catch (_) {}
  return null;
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

// Load persisted reminders on require
try { loadReminders(); } catch (_) {}

module.exports = {
  parseDuration,
  addReminder,
  listReminders,
  fetchLyrics,
  fetchWallpaper,
  resolveSpotifyToQuery,
  formatDuration
};
