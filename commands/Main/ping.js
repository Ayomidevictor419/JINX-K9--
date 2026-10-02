module.exports = {
  name: 'ping',
  category: 'main',
  description: 'Check bot response time',
  permission: 'public',
  async run({ sock, from, m }) {
    const started = process.hrtime.bigint();
    const sent = await sock.sendMessage(from, { text: '🏓 Ping...' }, { quoted: m });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    const ms = Math.max(1, Math.round(elapsed));
    if (sent?.key) {
      await sock.sendMessage(from, { text: `🏓 Pong! ${ms}ms`, edit: sent.key });
    } else {
      await sock.sendMessage(from, { text: `🏓 Pong! ${ms}ms` }, { quoted: m });
    }
  }
};
