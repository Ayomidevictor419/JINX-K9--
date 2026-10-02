const fs = require('fs');
const path = require('path');
const registry = require('./registry');
const commandLoader = require('./commandLoader');
const categoryFor = require('./category').categoryFor;

function loadLegacyCommands(handlerFile) {
  const text = fs.readFileSync(handlerFile, 'utf8');
  const lines = text.split(/\r?\n/);
  let inside = false;
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const name = pending[0].toLowerCase();
    if (!registry.has(name)) registry.register(name, { category: categoryFor(name), source: 'legacy', file: 'handler.js' });
    pending = [];
  };
  for (const line of lines) {
    if (!inside && /switch\s*\(command\)/.test(line)) { inside = true; continue; }
    if (!inside) continue;
    if (/^\s*default\s*:/.test(line)) { flush(); break; }
    const m = line.match(/^\s*case\s+['"]([^'"]+)['"]\s*:/);
    if (m) { pending.push(m[1]); continue; }
    if (pending.length) flush();
  }
  flush();
}

function load() {
  registry.clear();
  try { commandLoader.loadCommands(path.resolve(__dirname, '..', 'commands')); } catch (e) { console.error('[Bootstrap] Modern commands failed:', e.message); }
  try { loadLegacyCommands(path.resolve(__dirname, '..', 'handler.js')); } catch (e) { console.error('[Bootstrap] Legacy registry failed:', e.message); }
  return registry.all().length;
}
module.exports = { load };
