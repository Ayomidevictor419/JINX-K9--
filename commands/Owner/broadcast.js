const settings = require('../../lib/settings');
const { getBaileys } = require('../../lib/baileys');

async function downloadQuoted(m) {
  const ctx = m.message?.extendedTextMessage?.contextInfo || {};
  let q = ctx.quotedMessage;
  if (!q) return null;
  q = q.viewOnceMessage?.message || q.viewOnceMessageV2?.message || q.ephemeralMessage?.message || q;
  const type = Object.keys(q).find(k => ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'].includes(k));
  if (!type) return null;
  const { downloadContentFromMessage } = await getBaileys();
  const stream = await downloadContentFromMessage(q[type], type.replace('Message',''));
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return { type, msg: q[type], buffer: Buffer.concat(chunks) };
}

module.exports = {
  name: 'broadcast',
  category: 'owner',
  description: 'Broadcast text or replied media to known groups',
  async run({ args, reply, sock, m, isOwner, isModUser, sessionId }) {
    if (!isOwner && !isModUser) return reply('Owner or Mod permission is required for this action.');
    const groups = Object.keys(settings.get(sessionId, 'bot', 'knownGroups', {}) || {});
    if (!groups.length) return reply('No saved groups are available for broadcast.');
    const text = args.join(' ').trim();
    let media = null;
    try { media = await downloadQuoted(m); } catch {}
    if (!text && !media) return reply('Usage: .broadcast <message>\nOr reply to media with .broadcast [caption]');

    let sent = 0;
    let failed = 0;
    for (const jid of groups) {
      try {
        if (media) {
          const p = {};
          if (media.type === 'imageMessage') p.image = media.buffer;
          else if (media.type === 'videoMessage') p.video = media.buffer;
          else if (media.type === 'audioMessage') { p.audio = media.buffer; p.ptt = !!media.msg?.ptt; p.mimetype = media.msg?.mimetype || 'audio/mpeg'; }
          else if (media.type === 'stickerMessage') p.sticker = media.buffer;
          else { p.document = media.buffer; p.mimetype = media.msg?.mimetype || 'application/octet-stream'; p.fileName = media.msg?.fileName || 'broadcast'; }
          if (text && media.type !== 'stickerMessage') p.caption = text;
          await sock.sendMessage(jid, p);
        } else {
          await sock.sendMessage(jid, { text });
        }
        sent++;
        await new Promise(r => setTimeout(r, 700));
      } catch (e) {
        failed++;
        console.error(`[broadcast] failed for ${jid}:`, e?.message || e);
      }
    }
    return reply(`📢 Broadcast completed.\n\n• Delivered: ${sent}/${groups.length}\n• Failed: ${failed}`);
  }
};
