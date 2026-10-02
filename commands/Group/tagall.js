const { resolvePhoneJid } = require('../../lib/identity');

module.exports = {
  name: 'tagall',
  category: 'group',
  description: 'Tag all group members',
  async run({ sock, m, isGroup, isAdmin, isSudoUser, reply, from, text, participants }) {
    if (!isGroup) return reply('This command can only be used in groups.');
    if (!isAdmin && !isSudoUser) return reply('Only group admins or sudo can use this.');

    try {
      const metadata = await sock.groupMetadata(from);
      const groupParticipants = metadata.participants || participants || [];
      const members = [];
      for (const p of groupParticipants) {
        const jid = await resolvePhoneJid(sock, p?.id || p?.jid, groupParticipants) || p?.id || p?.jid;
        if (jid) members.push(String(jid));
      }
      const unique = [...new Set(members)];
      if (!unique.length) return reply('No members found.');

      const teks = String(text || '').trim() || 'Tag All';
      const mentionsText = unique.map(u => `@${String(u).split('@')[0]}`).join('\n');
      await sock.sendMessage(from, {
        text: `${teks}\n\n${mentionsText}`,
        mentions: unique
      }, { quoted: m });
    } catch (err) {
      console.error('[tagall]', err?.message || err);
      await reply('Unable to tag the group members. Please try again.');
    }
  }
};
