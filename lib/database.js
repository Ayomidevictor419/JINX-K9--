const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const { elevVariants, identitiesMatch } = require('./identity');

const DB_DIR = path.resolve(config.DATABASE_DIR);

// Ensure database directory exists
fs.ensureDirSync(DB_DIR);

function getPath(name) {
  return path.join(DB_DIR, `${name}.json`);
}

function read(name, defaultValue = {}) {
  const file = getPath(name);
  try {
    if (fs.existsSync(file)) {
      return fs.readJsonSync(file);
    }
  } catch (e) {
    console.error(`[DB] Failed to read ${name}:`, e.message);
  }
  return defaultValue;
}

function write(name, data) {
  const file = getPath(name);
  try {
    fs.writeJsonSync(file, data, { spaces: 2 });
    return true;
  } catch (e) {
    console.error(`[DB] Failed to write ${name}:`, e.message);
    return false;
  }
}

// ---------- Known Telegram users (for /broadcast) ----------
function getUsers() {
  return read('users', {});
}

function setUsers(data) {
  return write('users', data);
}

function trackUser(telegramId, name = '', username = '') {
  const id = String(telegramId);
  const users = getUsers();
  users[id] = {
    name: name || users[id]?.name || '',
    username: username || users[id]?.username || '',
    firstSeen: users[id]?.firstSeen || Date.now(),
    lastSeen: Date.now()
  };
  setUsers(users);
}

function getAllUserIds() {
  return Object.keys(getUsers());
}


// ---------- Telegram error reports ----------
function getErrorReports() { return read('error-reports', []); }
function addErrorReport(report = {}) {
  const list = getErrorReports();
  list.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    telegramId: String(report.telegramId || ''),
    name: String(report.name || ''),
    username: String(report.username || ''),
    error: String(report.error || '').slice(0, 4000),
    createdAt: Date.now()
  });
  while (list.length > 500) list.shift();
  write('error-reports', list);
  return list[list.length - 1];
}

// ---------- Sudo & Mods (per WhatsApp session) ----------
// Each role stores ONE canonical representative per logical user. identityMap
// maps every known phone/LID representation to that logical canonical key.
function getElevated() { return read('elevated', {}); }
function setElevated(data) { return write('elevated', data); }

function _canonicalFor(jid) {
  const { canonicalIdentity } = require('./identity');
  return canonicalIdentity(jid);
}

function _ensureSession(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  if (!Array.isArray(data.sudo)) data.sudo = [];
  if (!Array.isArray(data.mods)) data.mods = [];
  if (!data.identityMap || typeof data.identityMap !== 'object' || Array.isArray(data.identityMap)) data.identityMap = {};
  return data;
}

function _formsFor(jid, knownForms = []) {
  const { elevVariants } = require('./identity');
  const forms = new Set();
  for (const value of [jid, ...(knownForms || [])]) for (const v of elevVariants(value)) forms.add(String(v));
  return [...forms].filter(Boolean);
}

function _chooseCanonical(forms, fallback) {
  const phone = forms.find(v => _canonicalFor(v)?.startsWith('pn:'));
  return phone ? _canonicalFor(phone) : (_canonicalFor(fallback) || `raw:${String(fallback || '').toLowerCase()}`);
}

function _representative(forms, fallback) {
  return forms.find(v => /@(s\.whatsapp\.net|c\.us)$/i.test(v)) || forms.find(v => /@lid$/i.test(v)) || String(fallback || '').trim();
}

function _sanitizeElevatedSession(input) {
  const data = _ensureSession(input);
  let changed = false;
  const map = data.identityMap;

  for (const role of ['sudo', 'mods']) {
    const next = [];
    const seen = new Set();
    for (const stored of data[role]) {
      const raw = String(stored || '').trim();
      if (!raw) { changed = true; continue; }
      const canonical = map[raw] || _canonicalFor(raw) || `raw:${raw.toLowerCase()}`;
      if (seen.has(canonical)) { changed = true; continue; }
      seen.add(canonical);
      next.push(raw);
      map[raw] = canonical;
    }
    if (JSON.stringify(next) !== JSON.stringify(data[role])) { data[role] = next; changed = true; }
  }

  const activeKeys = new Set();
  const activeCanonicals = new Set();
  for (const role of ['sudo','mods']) {
    for (const stored of data[role]) {
      const key = String(stored);
      activeKeys.add(key);
      activeCanonicals.add(map[key] || _canonicalFor(key) || `raw:${key.toLowerCase()}`);
    }
  }
  for (const key of Object.keys(map)) {
    if (!activeKeys.has(key) && !activeCanonicals.has(map[key])) {
      delete map[key];
      changed = true;
    }
  }
  return { data, changed };
}

function getSessionElevated(sessionId) {
  const all = getElevated();
  const id = String(sessionId || '');
  const current = _sanitizeElevatedSession(all[id]);
  if (current.changed || !all[id]) { all[id] = current.data; setElevated(all); }
  return current.data;
}

function _matches(data, list, jid, knownForms = []) {
  const { canonicalIdentity } = require('./identity');
  const forms = _formsFor(jid, knownForms);
  const wanted = new Set(forms.map(v => data.identityMap[v] || canonicalIdentity(v)).filter(Boolean));
  return list.some(stored => {
    const key = String(stored);
    const storedCanonical = data.identityMap[key] || canonicalIdentity(key);
    return !!storedCanonical && wanted.has(storedCanonical);
  });
}

function _storeRole(sessionId, role, jid, knownForms = []) {
  const all = getElevated();
  const id = String(sessionId || '');
  const data = _ensureSession(all[id]);
  const forms = _formsFor(jid, knownForms);
  if (!forms.length) return false;
  const canonical = _chooseCanonical(forms, jid);
  const existing = data[role].find(stored => (data.identityMap[stored] || _canonicalFor(stored)) === canonical);
  const representative = existing || _representative(forms, jid);
  if (!existing) data[role].push(representative);
  for (const form of forms) data.identityMap[form] = canonical;
  data.identityMap[representative] = canonical;
  const cleaned = _sanitizeElevatedSession(data);
  all[id] = cleaned.data;
  setElevated(all);
  return true;
}

function _removeRole(sessionId, role, jid, knownForms = []) {
  const all = getElevated();
  const id = String(sessionId || '');
  if (!all[id]) return false;
  const data = _ensureSession(all[id]);
  const forms = _formsFor(jid, knownForms);
  const wanted = new Set(forms.map(v => data.identityMap[v] || _canonicalFor(v)).filter(Boolean));
  let changed = false;
  data[role] = data[role].filter(stored => {
    const canonical = data.identityMap[stored] || _canonicalFor(stored);
    if (wanted.has(canonical)) { changed = true; return false; }
    return true;
  });
  const activeKeys = new Set([...data.sudo, ...data.mods].map(String));
  const activeCanonicals = new Set([...activeKeys].map(key => data.identityMap[key] || _canonicalFor(key) || `raw:${key.toLowerCase()}`));
  for (const key of Object.keys(data.identityMap)) {
    if (!activeKeys.has(key) && !activeCanonicals.has(data.identityMap[key])) { delete data.identityMap[key]; changed = true; }
  }
  all[id] = data;
  setElevated(all);
  return changed;
}

function addSudo(sessionId, jid, knownForms = []) { return _storeRole(sessionId, 'sudo', jid, knownForms); }
function removeSudo(sessionId, jid, knownForms = []) { return _removeRole(sessionId, 'sudo', jid, knownForms); }
function addMod(sessionId, jid, knownForms = []) { return _storeRole(sessionId, 'mods', jid, knownForms); }
function removeMod(sessionId, jid, knownForms = []) { return _removeRole(sessionId, 'mods', jid, knownForms); }
function isSudo(sessionId, jid) { const d = getSessionElevated(sessionId); return _matches(d, d.sudo, jid); }
function isMod(sessionId, jid) { const d = getSessionElevated(sessionId); return _matches(d, d.mods, jid); }
function getSudoList(sessionId) { return getSessionElevated(sessionId).sudo; }
function getModList(sessionId) { return getSessionElevated(sessionId).mods; }

function isOwnerNumber(jid) {
  const num = String(jid || '').replace(/[^0-9]/g, '');
  return config.OWNER_NUMBERS.includes(num);
}

// ---------- Connected users (Telegram <-> WhatsApp mapping) ----------
function getConnections() {
  return read('connections', {});
}

function setConnections(data) {
  return write('connections', data);
}

function addConnection(telegramId, sessionId, phone) {
  const conns = getConnections();
  const id = String(telegramId);
  if (!conns[id]) conns[id] = [];
  if (!conns[id].find(c => c.sessionId === sessionId)) {
    conns[id].push({ sessionId, phone, connectedAt: Date.now() });
  }
  setConnections(conns);
}

function removeConnection(telegramId, sessionId) {
  const conns = getConnections();
  const id = String(telegramId);
  if (conns[id]) {
    conns[id] = conns[id].filter(c => c.sessionId !== sessionId);
    if (conns[id].length === 0) delete conns[id];
  }
  setConnections(conns);
}

function getUserConnections(telegramId) {
  const conns = getConnections();
  return conns[String(telegramId)] || [];
}

function getConnectionOwner(sessionId) {
  const target = String(sessionId);
  const conns = getConnections();
  for (const [telegramId, list] of Object.entries(conns)) {
    if (Array.isArray(list) && list.some(c => String(c.sessionId) === target)) return String(telegramId);
  }
  return null;
}

// ---------- Connection limits (per Telegram user) ----------
function getLimits() {
  return read('limits', { defaultMax: 1, users: {} });
}
function setLimits(data) {
  return write('limits', data || { defaultMax: 1, users: {} });
}
/** Max WhatsApp sessions allowed for a Telegram user (owner unlimited handled in bot.js) */
function getConnLimit(telegramId) {
  const limits = getLimits();
  const id = String(telegramId);
  if (limits.users && limits.users[id] !== undefined) return Number(limits.users[id]);
  return Number(limits.defaultMax || 1);
}
function setConnLimit(telegramId, max) {
  const limits = getLimits();
  if (!limits.users) limits.users = {};
  limits.users[String(telegramId)] = Math.max(1, parseInt(max, 10) || 1);
  setLimits(limits);
}
function setDefaultConnLimit(max) {
  const limits = getLimits();
  limits.defaultMax = Math.max(1, parseInt(max, 10) || 1);
  setLimits(limits);
}
function listAllConnections() {
  return getConnections();
}

module.exports = {
  read,
  write,
  getUsers,
  setUsers,
  trackUser,
  getAllUserIds,
  getErrorReports,
  addErrorReport,
  getElevated,
  setElevated,
  getSessionElevated,
  addSudo,
  removeSudo,
  addMod,
  removeMod,
  isSudo,
  isMod,
  getSudoList,
  getModList,
  isOwnerNumber,
  getConnections,
  setConnections,
  addConnection,
  removeConnection,
  getUserConnections,
  getConnectionOwner,
  getLimits,
  setLimits,
  getConnLimit,
  setConnLimit,
  setDefaultConnLimit,
  listAllConnections
};
