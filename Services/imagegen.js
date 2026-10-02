/**
 * Free image generation via Pollinations (no API key required).
 */
const axios = require('axios');

async function generateImage(prompt) {
  const q = String(prompt || '').trim();
  if (!q) throw new Error('Image prompt is empty.');

  const model = String(process.env.POLLINATIONS_IMAGE_MODEL || 'flux').trim() || 'flux';
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(q)}` +
    `?width=1024&height=1024&nologo=true&model=${encodeURIComponent(model)}&seed=${Date.now() % 100000}`;

  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 90000,
    maxContentLength: 25 * 1024 * 1024,
    headers: {
      'User-Agent': 'Jinx-K9-MD/9.0',
      Accept: 'image/*'
    },
    validateStatus: s => s < 500
  });

  if (res.status >= 400 || !res.data || res.data.byteLength < 500) {
    throw new Error('Image provider returned empty or error response');
  }

  return {
    buffer: Buffer.from(res.data),
    contentType: String(res.headers['content-type'] || 'image/jpeg'),
    url
  };
}

module.exports = { generateImage };
