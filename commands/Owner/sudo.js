const db = require('../../lib/database');
const { resolveElevatedTargets, expandIdentityForms } = require('../../lib/identity');

module.exports = {
  name: 'sudo',
  category: 'owner',
  description: 'Grant sudo access (session-scoped)',
  permission: 'owner',
  async run({ sock, m, args, reply, isOwner, isModUser, isSudoUser, sessionId, prefix, participants }) {
    if (!isOwner && !isModUser) {
      return reply('Sudo or higher permission is required for this action.');
    }
    const targets = await resolveElevatedTargets(sock, m, args, participants || []);
    if (!targets.length) {
      return reply(
        `🛡️ *Add Sudo*\n` +
        `• Reply to user: ${prefix}sudo\n` +
        `• Tag user: ${prefix}sudo @user\n` +
        `• Number: ${prefix}sudo 234xxxxxxxxxx\n` +
        `• All group admins: ${prefix}sudo admins`
      );
    }
    const added = [];
    for (const target of targets) {
      if (db.isSudo(sessionId, target) || db.isMod(sessionId, target)) continue;
      const forms = await expandIdentityForms(sock, target, participants || []);
      db.addSudo(sessionId, target, forms);
      added.push(target);
    }
    if (!added.length) return reply('No new Sudo access was granted. The target may already have elevated access or may be invalid.');
    const lines = added.map((j) => `@${String(j).split('@')[0]}`).join(', ');
    await reply(`🛡️ *Sudo Access Granted*\n\n${added.map((j) => `• @${String(j).split('@')[0]}`).join('\n')}`, { mentions: added });
  }
};
