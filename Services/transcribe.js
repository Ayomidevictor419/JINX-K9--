const axios = require('axios');

async function uploadGeminiFile(buffer, mimeType) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not configured.');

  const start = await axios.post(
    'https://generativelanguage.googleapis.com/upload/v1beta/files',
    { file: { display_name: `jinx-k9-audio-${Date.now()}` } },
    {
      timeout: 30000,
      headers: {
        'x-goog-api-key': key,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(buffer.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json'
      },
      maxBodyLength: 2 * 1024 * 1024 * 1024
    }
  );
  const uploadUrl =
    start.headers['x-goog-upload-url'] ||
    start.headers['X-Goog-Upload-URL'];
  if (!uploadUrl) throw new Error('Gemini did not return an upload URL.');

  const done = await axios.post(uploadUrl, buffer, {
    timeout: 120000,
    headers: {
      'Content-Length': String(buffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Type': mimeType
    },
    maxBodyLength: 2 * 1024 * 1024 * 1024
  });
  const file = done.data?.file || done.data;
  if (!file?.uri) throw new Error('Gemini file upload did not return a file URI.');
  return { uri: file.uri, mimeType: file.mimeType || mimeType };
}

async function transcribeWithGemini(buffer, mimeType) {
  const uploaded = await uploadGeminiFile(buffer, mimeType);
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe';
  const resp = await axios.post(
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    {
      model,
      input: [
        { type: 'audio', uri: uploaded.uri, mime_type: uploaded.mimeType },
        { type: 'text', text: 'Transcribe this voice message accurately. Automatically detect the spoken language. Return only the transcript, preserving the language spoken.' }
      ],
      generation_config: {
        transcription_config: {
          mode: 'smart',
          language_codes: []
        }
      }
    },
    {
      timeout: 120000,
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }
    }
  );
  const text =
    resp.data?.output_text ||
    (resp.data?.outputs || []).filter(x => x.type === 'text').map(x => x.text).join('\n') ||
    '';
  if (!text.trim()) throw new Error('Gemini returned an empty transcription.');
  return text.trim();
}

async function transcribe(buffer, mimeType = 'audio/ogg') {
  const attempts = [];
  if (process.env.GEMINI_API_KEY) attempts.push(() => transcribeWithGemini(buffer, mimeType));
  let last;
  for (const fn of attempts) {
    try { return await fn(); } catch (e) { last = e; }
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Voice transcription needs GEMINI_API_KEY in config.env.');
  }
  throw new Error(last?.response?.data?.error?.message || last?.message || 'Transcription failed.');
}

module.exports = { transcribe };
