/**
 * Canonical command loader for 𝙅𝙄𝙉𝙓 𝙆9.
 * Loads implementations from commands/ and registers only their canonical names.
 */
const fs = require('fs');
const path = require('path');
const registry = require('./registry');

const commands = new Map();
const categories = {};

function loadCommands(commandsDir = path.join(process.cwd(), 'commands')) {
  if (!fs.existsSync(commandsDir)) return 0;
  commands.clear();
  for (const key of Object.keys(categories)) delete categories[key];
  let total = 0;
  const categoryDirs = fs.readdirSync(commandsDir).filter(name => {
    const full = path.join(commandsDir, name);
    return fs.statSync(full).isDirectory();
  });
  for (const category of categoryDirs) {
    const categoryPath = path.join(commandsDir, category);
    categories[category] = [];
    for (const file of fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'))) {
      const filePath = path.join(categoryPath, file);
      try {
        delete require.cache[require.resolve(filePath)];
        const cmd = require(filePath);
        if (!cmd?.name || typeof cmd.run !== 'function') continue;
        const name = String(cmd.name).toLowerCase().trim();
        if (!name || commands.has(name)) {
          console.warn(`[CommandLoader] Duplicate/invalid canonical command skipped: ${name || file}`);
          continue;
        }
        const entry = { ...cmd, name, category, file, source: 'modern' };
        commands.set(name, entry);
        categories[category].push(name);
        registry.register(name, {
          category: String(cmd.category || category).toUpperCase(),
          source: 'modern',
          file: path.relative(process.cwd(), filePath)
        });
        total++;
      } catch (err) {
        console.error(`[CommandLoader] Error loading ${category}/${file}:`, err.message);
      }
    }
  }
  console.log(`[CommandLoader] Loaded ${total} canonical commands from ${categoryDirs.length} categories`);
  return total;
}

function getCommand(name) { return commands.get(String(name || '').toLowerCase()); }
function getAllCommands() { return [...commands.values()]; }
function getCommandsByCategory() { return Object.fromEntries(Object.entries(categories).map(([k,v]) => [k,[...v]])); }
function hasCommand(name) { return commands.has(String(name || '').toLowerCase()); }

module.exports = { loadCommands, getCommand, getAllCommands, getCommandsByCategory, hasCommand, commands };
