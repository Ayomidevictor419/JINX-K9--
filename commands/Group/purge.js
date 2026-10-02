const settings = require('../../lib/settings');

function getTargets(m, args = []) {
  const ctx = m.message?.extendedTextMessage?.contextInfo || {};
  const out = new Set(ctx.mentionedJid || []);
  if (ctx.participant) out.add(ctx.participant);
  for (const a of args) {
    const s = String(a || '').trim();
    if (s.includes('@')) out.add(s);
    else {
      const n = s.replace(/\D/g, '');
      if (n.length >= 8 && n.length <= 15) out.add(n + '@s.whatsapp.net');
    }
  }
  return [...out];
}

module.exports = {
  name: 'purge',
  category: 'group',
  description: 'Remove selected group members in one command',
  async run({ args, m, reply, sock, from, isGroup, isAdmin, isSudoUser, isBotAdmin }) {
    if (!isGroup) return reply('This command can only be used in groups.');
    if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo can use this.');
    if (!isBotAdmin) return reply('The bot must be a group admin to remove members.');
    const targets = getTargets(m, args).filter(Boolean);
    if (!targets.length) return reply('Reply to, tag, or provide the number of the member to purge.');
    const meta = await sock.groupMetadata(from).catch(() => null);
    const admins = new Set((meta?.participants || []).filter(p => p.admin).map(p => p.id));
    const bot = String(sock.user?.id || '').split(':')[0];
    const safe = targets.filter(t => !admins.has(t) && !String(t).startsWith(bot));
    if (!safe.length) return reply('No removable members were selected. Admins and the bot are protected.');
    const removed = [];
    for (const jid of safe) {
      try {
        await sock.groupParticipantsUpdate(from, [jid], 'remove');
        removed.push(jid);
      } catch {}
    }
    if (!removed.length) return reply('Unable to remove the selected member(s). Please verify the bot has admin permission.');
    return reply(`🧹 Members removed successfully:\n${removed.map(j => `• @${j.split('@')[0]}`).join('\n')}`, { mentions: removed });
  }
};
