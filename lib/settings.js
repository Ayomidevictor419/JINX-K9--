const fs = require('fs-extra');
const path = require('path');
const config = require('../config');

const SETTINGS_FILE = path.resolve('./database/settings.json');

fs.ensureDirSync(path.dirname(SETTINGS_FILE));
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeJsonSync(SETTINGS_FILE, {}, { spaces: 2 });
}

let settings = {};
let saveTimer = null;
let dirty = false;
const muteTimers = new Map();

function load() {
  try {
    const data = fs.readJsonSync(SETTINGS_FILE);
    settings = (data && typeof data === 'object') ? data : {};
  } catch (e) {
    settings = {};
  }
}
load();

function flush() {
  if (!dirty) return;
  try {
    fs.writeJsonSync(SETTINGS_FILE, settings, { spaces: 2 });
    dirty = false;
  } catch (e) {
    console.error('[Settings] Failed to save:', e.message);
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 600);
  if (saveTimer.unref) saveTimer.unref();
}

for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(sig, () => { try { flush(); } catch (e) {} });
}

function scopeKey(sessionId, jid = 'bot') {
  const s = String(sessionId || 'global').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!jid || jid === 'bot') return `${s}:bot`;
  return `${s}:${String(jid)}`;
}

function get(sessionId, jid, key, defaultValue = false) {
  try {
    const sk = scopeKey(sessionId, jid);
    if (settings[sk] && Object.prototype.hasOwnProperty.call(settings[sk], key)) {
      return settings[sk][key];
    }
  } catch (e) {}
  return defaultValue;
}

function set(sessionId, jid, key, value) {
  try {
    const sk = scopeKey(sessionId, jid);
    if (!settings[sk]) settings[sk] = {};
    settings[sk][key] = value;
    scheduleSave();
  } catch (e) {
    console.error('[Settings] set error:', e.message);
  }
}

function del(sessionId, jid, key) {
  try {
    const sk = scopeKey(sessionId, jid);
    if (settings[sk]) {
      delete settings[sk][key];
      scheduleSave();
    }
  } catch (e) {}
}

// ---- Prefix ----
function getPrefix(sessionId) {
  return get(sessionId, 'bot', 'prefix', config.DEFAULT_PREFIX);
}
function setPrefix(sessionId, prefix) {
  set(sessionId, 'bot', 'prefix', String(prefix).slice(0, 3));
}

// ---- Feature toggles (per group, per session) ----
function featureOn(sessionId, groupJid, name) {
  return !!get(sessionId, groupJid, `feature_${name}`, false);
}
function setFeature(sessionId, groupJid, name, value) {
  set(sessionId, groupJid, `feature_${name}`, !!value);
}
function getFeatureConfig(sessionId, groupJid, name, def = { action: 'delete', maxWarnings: 3 }) {
  return get(sessionId, groupJid, `config_${name}`, def);
}
function setFeatureConfig(sessionId, groupJid, name, cfg) {
  set(sessionId, groupJid, `config_${name}`, cfg);
}

// ---- Warnings store (per group) ----
function getWarns(sessionId, groupJid) {
  return get(sessionId, groupJid, 'warns', {}) || {};
}
function setWarns(sessionId, groupJid, data) {
  set(sessionId, groupJid, 'warns', data || {});
}
function addWarn(sessionId, groupJid, userJid) {
  const warns = getWarns(sessionId, groupJid);
  const key = String(userJid);
  warns[key] = (warns[key] || 0) + 1;
  setWarns(sessionId, groupJid, warns);
  recordDailyEvent(sessionId, groupJid, 'warnings', 1);
  return warns[key];
}
function resetWarn(sessionId, groupJid, userJid) {
  const warns = getWarns(sessionId, groupJid);
  delete warns[String(userJid)];
  setWarns(sessionId, groupJid, warns);
}

// Convenience
function isAntiLink(sessionId, groupJid) { return featureOn(sessionId, groupJid, 'antilink'); }
function setAntiLink(sessionId, groupJid, v) { setFeature(sessionId, groupJid, 'antilink', v); }
function isAntiBot(sessionId, groupJid) { return featureOn(sessionId, groupJid, 'antibot'); }
function setAntiBot(sessionId, groupJid, v) { setFeature(sessionId, groupJid, 'antibot', v); }
function isWelcome(sessionId, groupJid) { return featureOn(sessionId, groupJid, 'welcome'); }
function setWelcome(sessionId, groupJid, v) { setFeature(sessionId, groupJid, 'welcome', v); }
function getWelcomeText(sessionId, groupJid) {
  const def =
    '👋 Welcome @user to *@group*!\n\n' +
    '📌 *Please introduce yourself:*\n' +
    '• Name:\n• Age:\n• Location:\n• Hobbies:\n\n' +
    '📸 Photos/videos should be sent as *View Once* where appropriate.\n' +
    '👥 We are now *@members* members in the group.\n\n' +
    'Thanks for joining! 🎉';
  return get(sessionId, groupJid, 'welcometext', get(sessionId, groupJid, 'welcomeText', def));
}
function setWelcomeText(sessionId, groupJid, text) { set(sessionId, groupJid, 'welcometext', String(text || '')); }
function isGoodbye(sessionId, groupJid) { return featureOn(sessionId, groupJid, 'goodbye'); }
function setGoodbye(sessionId, groupJid, v) { setFeature(sessionId, groupJid, 'goodbye', v); }
function getGoodbyeText(sessionId, groupJid) { return get(sessionId, groupJid, 'goodbyetext', '👋 Goodbye @user'); }
function setGoodbyeText(sessionId, groupJid, text) { set(sessionId, groupJid, 'goodbyetext', String(text || '')); }


// ---- Muted users (per group): { userJid: unmuteAtMs }
function getMutedUsers(sessionId, groupJid) {
  return get(sessionId, groupJid, 'mutedUsers', {}) || {};
}
function setMutedUsers(sessionId, groupJid, data) {
  set(sessionId, groupJid, 'mutedUsers', data || {});
}
function muteUser(sessionId, groupJid, userJid, durationMs) {
  const data = getMutedUsers(sessionId, groupJid);
  const id = String(userJid);
  const num = id.replace(/[^0-9]/g, '');
  const until = (!durationMs || durationMs <= 0) ? 0 : (Date.now() + durationMs);
  data[id] = until;
  if (num) data[num] = until;
  setMutedUsers(sessionId, groupJid, data);

  // Keep a live expiry timer as well as the persisted timestamp. The timestamp
  // makes the mute safe across restarts; this timer cleans it up automatically
  // while the process is running.
  const timerKey = `${sessionId}|${groupJid}|${id}`;
  const old = muteTimers.get(timerKey);
  if (old) clearTimeout(old);
  if (until > 0) {
    const timer = setTimeout(() => {
      try { unmuteUser(sessionId, groupJid, userJid); } catch (e) {}
      muteTimers.delete(timerKey);
    }, Math.max(1, until - Date.now()));
    if (timer.unref) timer.unref();
    muteTimers.set(timerKey, timer);
  }
}
function unmuteUser(sessionId, groupJid, userJid) {
  const data = getMutedUsers(sessionId, groupJid);
  const id = String(userJid);
  const num = id.replace(/[^0-9]/g, '');
  const timerKey = `${sessionId}|${groupJid}|${id}`;
  const old = muteTimers.get(timerKey);
  if (old) clearTimeout(old);
  muteTimers.delete(timerKey);
  delete data[id];
  if (num) delete data[num];
  // remove any key matching this number
  for (const k of Object.keys(data)) {
    if (k.replace(/[^0-9]/g, '') === num) delete data[k];
  }
  setMutedUsers(sessionId, groupJid, data);
}
function isUserMuted(sessionId, groupJid, userJid) {
  const data = getMutedUsers(sessionId, groupJid);
  const id = String(userJid || '');
  const num = id.replace(/[^0-9]/g, '');
  let until = data[id];
  if (until === undefined && num) until = data[num];
  if (until === undefined && num) {
    for (const [k, v] of Object.entries(data)) {
      if (String(k).replace(/[^0-9]/g, '') === num) { until = v; break; }
    }
  }
  if (until === undefined) return false;
  // 0 = permanent mute
  if (until === 0) return true;
  if (Date.now() >= until) {
    unmuteUser(sessionId, groupJid, userJid);
    return false;
  }
  return true;
}


// Per-feature warning counters (do not share with manual ?warn)
function addFeatureWarn(sessionId, groupJid, feature, userJid) {
  const key = feature + 'Warnings';
  const map = get(sessionId, groupJid, key, {}) || {};
  const id = String(userJid);
  const entry = map[id] || { count: 0 };
  entry.count = (entry.count || 0) + 1;
  entry.last = Date.now();
  map[id] = entry;
  set(sessionId, groupJid, key, map);
  recordDailyEvent(sessionId, groupJid, 'warnings', 1);
  return entry.count;
}
function resetFeatureWarn(sessionId, groupJid, feature, userJid) {
  const key = feature + 'Warnings';
  const map = get(sessionId, groupJid, key, {}) || {};
  delete map[String(userJid)];
  set(sessionId, groupJid, key, map);
}
function getFeatureWarn(sessionId, groupJid, feature, userJid) {
  const map = get(sessionId, groupJid, feature + 'Warnings', {}) || {};
  return (map[String(userJid)] || {}).count || 0;
}

// ---- Daily group statistics (per session + group) ----
function localDayKey() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: config.TIMEZONE || 'Africa/Lagos',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function getDailyStats(sessionId, groupJid) {
  const today = localDayKey();
  const current = get(sessionId, groupJid, 'dailyStats', null);
  if (!current || current.date !== today) {
    const fresh = {
      date: today,
      messages: 0,
      commands: 0,
      games: 0,
      warnings: 0,
      linkBlocks: 0,
      users: {}
    };
    set(sessionId, groupJid, 'dailyStats', fresh);
    return fresh;
  }
  current.users = current.users || {};
  return current;
}

function recordDailyMessage(sessionId, groupJid, userJid, displayName, isCommand = false) {
  const stats = getDailyStats(sessionId, groupJid);
  stats.messages += 1;
  if (isCommand) stats.commands += 1;
  const id = String(userJid || '');
  if (id) {
    const u = stats.users[id] || { count: 0, name: '' };
    u.count += 1;
    if (displayName) u.name = String(displayName).slice(0, 80);
    stats.users[id] = u;
  }
  set(sessionId, groupJid, 'dailyStats', stats);
  return stats;
}

function recordDailyEvent(sessionId, groupJid, event, amount = 1) {
  const stats = getDailyStats(sessionId, groupJid);
  if (Object.prototype.hasOwnProperty.call(stats, event)) {
    stats[event] = Math.max(0, Number(stats[event] || 0) + Number(amount || 0));
  }
  set(sessionId, groupJid, 'dailyStats', stats);
  return stats;
}

function decrementWarn(sessionId, groupJid, userJid) {
  const warns = getWarns(sessionId, groupJid);
  const key = String(userJid);
  const old = Number(warns[key] || 0);
  if (old <= 0) return 0;
  if (old === 1) delete warns[key];
  else warns[key] = old - 1;
  setWarns(sessionId, groupJid, warns);
  return Math.max(0, old - 1);
}

function decrementFeatureWarn(sessionId, groupJid, feature, userJid) {
  const key = feature + 'Warnings';
  const map = get(sessionId, groupJid, key, {}) || {};
  const id = String(userJid);
  const entry = map[id];
  const old = Number(entry?.count || 0);
  if (old <= 0) return 0;
  if (old === 1) delete map[id];
  else {
    entry.count = old - 1;
    entry.last = Date.now();
    map[id] = entry;
  }
  set(sessionId, groupJid, key, map);
  return Math.max(0, old - 1);
}

module.exports = {
  get, set, del,
  getPrefix, setPrefix,
  featureOn, setFeature, getFeatureConfig, setFeatureConfig,
  getWarns, setWarns, addWarn, resetWarn,
  isAntiLink, setAntiLink,
  isAntiBot, setAntiBot,
  isWelcome, setWelcome, getWelcomeText, setWelcomeText,
  isGoodbye, setGoodbye, getGoodbyeText, setGoodbyeText,
  getMutedUsers, setMutedUsers, muteUser, unmuteUser, isUserMuted,
  addFeatureWarn, resetFeatureWarn, getFeatureWarn, decrementFeatureWarn,
  getDailyStats, recordDailyMessage, recordDailyEvent, decrementWarn,
  flush
};
