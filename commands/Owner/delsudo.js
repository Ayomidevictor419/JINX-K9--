const db = require('../../lib/database');
const { resolveElevatedTargets, expandIdentityForms } = require('../../lib/identity');

module.exports = {
  name: 'delsudo',
  category: 'owner',
  description: 'Remove sudo access (session-scoped)',
  permission: 'owner',
  async run({ sock, m, args, reply, isOwner, isModUser, sessionId, prefix, participants }) {
    if (!isOwner && !isModUser) {
      return reply('This action is restricted to the session owner.');
    }
    const targets = await resolveElevatedTargets(sock, m, args, participants || []);
    if (!targets.length) {
      return reply(
        `🛡️ *Remove Sudo*\n` +
        `• Reply: ${prefix}delsudo\n` +
        `• Tag: ${prefix}delsudo @user\n` +
        `• Number: ${prefix}delsudo 234xxxxxxxxxx`
      );
    }
    const removed = [];
    for (const target of targets) {
      // Expand to every known form so we clear LID and phone variants together.
      const forms = await expandIdentityForms(sock, target, participants || []);
      const hit = db.removeSudo(sessionId, target, forms);
      if (hit) removed.push(target);
    }
    if (!removed.length) return reply('No matching Sudo record was found for the selected user.');
    await reply(
      `🛡️ *Sudo Access Removed*\n\n${removed.map((j) => `• @${String(j).split('@')[0]}`).join('\n')}`,
      { mentions: removed }
    );
  }
};
