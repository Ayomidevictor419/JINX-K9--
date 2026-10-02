const fs = require('fs');
const path = require('path');
const registry = require('../../core/registry');
const { ORDER } = require('../../core/category');
const fonts = require('../../lib/fonts/style-font');

function formatCommands(names, prefix) { return names.map(name => `│ ${fonts.serif_B(`${prefix}${name}`)}`).join('\n'); }
function formatCategory(category) { return fonts.serif_B(category); }
function buildCommandList() {
  return registry.all().map(item => ({ name: item.name, category: String(item.category || 'UTILITY').toUpperCase() }));
}

module.exports = {
  name: 'menu',
  category: 'main',
  description: 'Show the complete categorized command menu',
  permission: 'public',
  async run({ reply, sock, from, m, prefix, pushname, sender }) {
    const commands = buildCommandList();
    const grouped = new Map();
    for (const cmd of commands) (grouped.get(cmd.category) || (grouped.set(cmd.category, []), grouped.get(cmd.category))).push(cmd.name);
    for (const names of grouped.values()) names.sort();
    const number = String(sender || '').split('@')[0];
    const user = pushname || (number ? `+${number}` : 'User');
    const header = [
      '```┌────═━┈ 𝙅𝙄𝙉𝙓 𝙆9 ┈━═────┐',
      ` ✦ ▸ User: ${user}`,
      ` ✦ ▸ Commands: ${commands.length}`,
      ` ✦ ▸ Prefix: ${prefix}`,
      ` ✦ ▸ Version: V${require('../../package.json').version}`,
      '└────────═━┈┈━═────────┘```'
    ].join('\n');
    const sections=[];
    for (const category of [...ORDER, ...[...grouped.keys()].filter(c => !ORDER.includes(c))]) {
      const names=grouped.get(category); if(!names?.length) continue;
      sections.push(`┏ ${formatCategory(category)} ┓\n┍   ─┉─ • ─┉─   ┑\n${formatCommands(names,prefix)}\n┕   ─┉─ • ─┉─   ┙`);
    }
    const text=`${header}\n\n${sections.join('\n\n')}\n\n_Use ${prefix}menu to view this menu again._`;
    const image=path.join(process.cwd(),'media','jinx-whatsapp-menu.png');
    if(sock && from && fs.existsSync(image)) {
      try { return await sock.sendMessage(from,{image:fs.readFileSync(image),caption:text},m?{quoted:m}:undefined); } catch(e) { console.error('[menu] image send failed:',e.message); }
    }
    return reply(text,{raw:true});
  },
  _buildCommandList: buildCommandList
};
