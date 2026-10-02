const settings = require('../../lib/settings');

module.exports = {
  name: 'antibadword',
  category: 'group',
  description: 'Toggle and configure the bad-word filter',
  async run({ args, reply, isGroup, isAdmin, isSudoUser, sessionId, from, prefix }) {
    if (!isGroup) return reply('This command can only be used in groups.');
    if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo can use this.');

    const action = String(args[0] || 'status').toLowerCase();
    const cfg = settings.getFeatureConfig(sessionId, from, 'antiword') || { words: [], action: 'delete', maxWarnings: 3 };
    cfg.words = Array.isArray(cfg.words) ? cfg.words : [];

    if (action === 'on' || action === 'enable') {
      settings.setFeature(sessionId, from, 'antiword', true);
      settings.setFeatureConfig(sessionId, from, 'antiword', cfg);
      return reply(`✅ Anti-badword is now ON.\nAction: ${cfg.action}\nWords: ${cfg.words.length}`);
    }
    if (action === 'off' || action === 'disable') {
      settings.setFeature(sessionId, from, 'antiword', false);
      return reply('🛑 Anti-badword is now OFF.');
    }
    if (action === 'add') {
      const word = args.slice(1).join(' ').trim().toLowerCase();
      if (!word) return reply(`Usage: ${prefix}antibadword add <word>
Example: ${prefix}antibadword add spam`);
      if (!cfg.words.includes(word)) cfg.words.push(word);
      settings.setFeatureConfig(sessionId, from, 'antiword', cfg);
      return reply(`✅ Added: ${word}\nWords: ${cfg.words.length}`);
    }
    if (action === 'remove') {
      const word = args.slice(1).join(' ').trim().toLowerCase();
      if (!word) return reply(`Usage: ${prefix}antibadword remove <word>
Example: ${prefix}antibadword remove spam`);
      cfg.words = cfg.words.filter(w => w !== word);
      settings.setFeatureConfig(sessionId, from, 'antiword', cfg);
      return reply(`✅ Removed: ${word}\nWords: ${cfg.words.length}`);
    }
    if (action === 'action') {
      const mode = String(args[1] || '').toLowerCase();
      if (!['delete', 'warn', 'kick'].includes(mode)) return reply(`Usage: ${prefix}antibadword action delete|warn|kick`);
      cfg.action = mode;
      settings.setFeatureConfig(sessionId, from, 'antiword', cfg);
      return reply(`✅ Anti-badword action: ${mode}`);
    }
    return reply(`🛡️ Anti-badword: ${settings.featureOn(sessionId, from, 'antiword') ? 'ON' : 'OFF'}\nAction: ${cfg.action}\nWords: ${cfg.words.length}\n\n${prefix}antibadword on|off\n${prefix}antibadword add <word>\n${prefix}antibadword remove <word>\n${prefix}antibadword action delete|warn|kick`);
  }
};
