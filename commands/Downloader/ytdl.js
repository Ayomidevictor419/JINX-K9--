const { downloadMp3, downloadMp3Url, downloadRemoteAudio } = require('../../services/youtube');

module.exports = {
  name: 'ytdl',
  category: 'downloader',
  description: 'Download audio from a YouTube URL',
  async run({ args, reply, sock, from, m }) {
    const url = String(args[0] || '').trim();
    if (!url) return reply('Usage: .ytdl <YouTube URL>');
    try {
      let title = 'audio';
      try {
        const remote = await downloadMp3Url(url);
        title = remote.title || title;
        await sock.sendMessage(from, {
          audio: await downloadRemoteAudio(remote.url),
          mimetype: 'audio/mpeg',
          fileName: `${String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.mp3`
        }, { quoted: m });
        return;
      } catch (providerErr) {
        console.error('ytdl primary provider failed:', providerErr?.message || providerErr);
      }
      const result = await downloadMp3(url);
      title = result.title || title;
      await sock.sendMessage(from, {
        audio: result.buffer,
        mimetype: 'audio/mpeg',
        fileName: `${String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.mp3`
      }, { quoted: m });
    } catch (e) {
      return reply(`❌ YouTube download failed: ${e.message}`);
    }
  }
};
