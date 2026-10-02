const db = require('../../lib/database');
const { resolveElevatedTargets, expandIdentityForms } = require('../../lib/identity');

module.exports = {
  name: 'mod',
  category: 'owner',
  description: 'Grant mod access (session-scoped)',
  permission: 'owner',
  async run({ sock, m, args, reply, isOwner, isModUser, sessionId, prefix, participants }) {
    if (!isOwner && !isModUser) {
      return reply('This action is restricted to the session owner.');
    }
    const targets = await resolveElevatedTargets(sock, m, args, participants || []);
    if (!targets.length) {
      return reply(
        `🛡️ *Add Mod*\n` +
        `• Reply to user: ${prefix}mod\n` +
        `• Tag user: ${prefix}mod @user\n` +
        `• Number: ${prefix}mod 234xxxxxxxxxx\n` +
        `• All group admins: ${prefix}mod admins`
      );
    }
    const added = [];
    for (const target of targets) {
      if (db.isMod(sessionId, target)) continue;
      const forms = await expandIdentityForms(sock, target, participants || []);
      db.addMod(sessionId, target, forms);
      added.push(target);
    }
    if (!added.length) return reply('No new Mod access was granted. The target may already be a Mod or may be invalid.');
    await reply(
      `🛡️ *Mod Access Granted*\n\n${added.map((j) => `• @${String(j).split('@')[0]}`).join('\n')}`,
      { mentions: added }
    );
  }
};
