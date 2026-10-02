const ai = require('../../services/ai');

module.exports = {
  name: 'ai',
  category: 'ai',
  description: 'Ask AI anything',
  async run({ reply, text }) {
    if (!text) {
      return reply('Example: .ai What is Node.js?', { raw: true });
    }

    try {
      const answer = await ai.ask('auto', text);
      return reply(answer, { raw: true });
    } catch (err) {
      return reply(err?.message || 'AI is unavailable right now. Please try again later.');
    }
  }
};
