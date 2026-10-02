const settings = require('../../lib/settings');
const config = require('../../config');

module.exports = {
  name: 'mode',
  category: 'owner',
  description: 'Set bot private/public mode (session-scoped)',
  permission: 'owner',
  async run({ args, text, reply, isOwner, isModUser, sessionId, prefix }) {
    if (!isOwner) {
      return reply('This action is restricted to the session owner.');
    }
    const opt = String(args[0] || text || '').toLowerCase().trim();
    const current = String(settings.get(sessionId, 'bot', 'worktype', 'private') || 'private').toLowerCase();
    if (!opt || !['public', 'private'].includes(opt)) {
      return reply(
        `*Bot Mode*\n` +
        `Current: *${current.toUpperCase()}*\n\n` +
        `Usage:\n` +
        `${prefix}mode public  — everyone can use commands\n` +
        `${prefix}mode private — only Owner / Mod / Sudo`
      );
    }
    if (current === opt) return reply(`ℹ️ Bot mode is already set to *${opt.toUpperCase()}*.`);
    settings.set(sessionId, 'bot', 'worktype', opt);
    await reply(
      opt === 'public'
        ? '🌐 *Public Mode Enabled*\nNormal commands are available to regular users.'
        : '🔒 *Private Mode Enabled*\nOnly the Owner, Mod and Sudo can use commands.'
    );
  }
};
