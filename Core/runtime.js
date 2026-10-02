const fs = require('fs-extra');
const path = require('path');

const FILE = path.resolve('./database/runtime.json');
fs.ensureDirSync(path.dirname(FILE));
let data = {};
try { data = fs.readJsonSync(FILE) || {}; } catch { data = {}; }
let timer = null;
let dirty = false;
function save() {
  if (!dirty) return;
  try { fs.writeJsonSync(FILE, data, { spaces: 2 }); dirty = false; } catch {}
}
function schedule() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; save(); }, 500);
  timer.unref?.();
}
function ensure(sessionId) {
  const id = String(sessionId);
  if (!data[id] || typeof data[id] !== 'object') data[id] = {};
  return data[id];
}
function markConnected(sessionId) {
  const row = ensure(sessionId);
  if (!Number.isFinite(Number(row.connectedAt)) || Number(row.connectedAt) <= 0) row.connectedAt = Date.now();
  row.lastSeenAt = Date.now();
  row.connected = true;
  schedule();
  return row.connectedAt;
}
function markDisconnected(sessionId) {
  const row = ensure(sessionId);
  row.connected = false;
  row.lastSeenAt = Date.now();
  schedule();
}
function get(sessionId) { return { ...ensure(sessionId) }; }
function elapsed(sessionId) {
  const at = Number(ensure(sessionId).connectedAt || 0);
  return at > 0 ? Math.max(0, Date.now() - at) : 0;
}
function format(ms) {
  ms = Math.max(0, Number(ms) || 0);
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h ${m}m ${sec}s`;
  if (h) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec}s`;
}
function display(sessionId) { return format(elapsed(sessionId)); }
function flush() { save(); }
module.exports = { markConnected, markDisconnected, get, elapsed, format, display, flush };
