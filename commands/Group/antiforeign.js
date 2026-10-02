const settings = require('../../lib/settings');

module.exports = {
  name: 'antiforeign',
  category: 'group',
  description: 'Block non-Nigerian phone numbers from joining the group',
  async run({ args, reply, isGroup, isAdmin, isSudoUser, sessionId, from, prefix }) {
    if (!isGroup) return reply('This command can only be used in groups.');
    if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo can use this.');
    const action = String(args[0] || 'status').toLowerCase();
    if (action === 'on' || action === 'enable') {
      settings.setFeature(sessionId, from, 'antiforeign', true);
      return reply('🌍 Anti-foreign is now ON. Non-234 numbers will be removed when they join.');
    }
    if (action === 'off' || action === 'disable') {
      settings.setFeature(sessionId, from, 'antiforeign', false);
      return reply('🌍 Anti-foreign is now OFF.');
    }
    return reply(`🌍 Anti-foreign: ${settings.featureOn(sessionId, from, 'antiforeign') ? 'ON' : 'OFF'}\nUsage: ${prefix}antiforeign on|off`);
  }
};
