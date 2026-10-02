// ONE authoritative command registry for 𝙅𝙄𝙉𝙓 𝙆9.
const registry = new Map();

function register(name, meta = {}) {
  const key = String(name || '').toLowerCase().trim();
  if (!key) return false;
  if (registry.has(key)) return false;
  registry.set(key, { name: key, ...meta });
  return true;
}

function get(name) { return registry.get(String(name || '').toLowerCase().trim()); }
function has(name) { return !!get(name); }
function all() { return [...registry.values()].sort((a,b) => a.name.localeCompare(b.name)); }
function categories() {
  const out = {};
  for (const item of all()) (out[item.category || 'UTILITY'] ||= []).push(item.name);
  return out;
}
function clear() { registry.clear(); }
module.exports = { register, get, has, all, categories, clear };
