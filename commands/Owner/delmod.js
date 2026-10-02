const db = require('../../lib/database');
const { resolveElevatedTargets, expandIdentityForms } = require('../../lib/identity');

module.exports = {
  name: 'delmod',
  category: 'owner',
  description: 'Remove mod access (session-scoped)',
  permission: 'owner',
  async run({ sock, m, args, reply, isOwner, isModUser, sessionId, prefix, participants }) {
    if (!isOwner && !isModUser) {
      return reply('This action is restricted to the session owner.');
    }
    const targets = await resolveElevatedTargets(sock, m, args, participants || []);
    if (!targets.length) {
      return reply(
        `🛡️ *Remove Mod*\n` +
        `• Reply: ${prefix}delmod\n` +
        `• Tag: ${prefix}delmod @user\n` +
        `• Number: ${prefix}delmod 234xxxxxxxxxx`
      );
    }
    const removed = [];
    for (const target of targets) {
      const forms = await expandIdentityForms(sock, target, participants || []);
      const hit = db.removeMod(sessionId, target, forms);
      if (hit) removed.push(target);
    }

    if (!removed.length) return reply('No matching Mod record was found for the selected user.');
    await reply(
      `🛡️ *Mod Access Removed*\n\n${removed.map((j) => `• @${String(j).split('@')[0]}`).join('\n')}`,
      { mentions: removed }
    );
  }
};
