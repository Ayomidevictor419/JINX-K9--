const { Readable } = require('stream');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { get_ytmp3 } = require('./ytaudio-provider');

let ytPromise = null;

// YouTube periodically changes its player/signature setup. A fixed known-good
// player id avoids the common "Failed to extract signature decipher algorithm"
// failure seen with youtubei.js when it auto-selects a bad player.
const PLAYER_IDS = ['0004de42', null];

async function createClient(player_id) {
  const mod = await import('youtubei.js');
  const { Innertube, UniversalCache, ClientType } = mod;
  const opts = {
    cache: new UniversalCache(false),
    // WEB is reliable for normal search/info requests. The actual media
    // download below explicitly asks for the TV audio format when needed.
    client_type: ClientType?.WEB || 'WEB',
    retrieve_player: true,
    generate_session_locally: true
  };
  if (player_id) opts.player_id = player_id;
  return Innertube.create(opts);
}

async function getYouTube() {
  if (!ytPromise) {
    ytPromise = (async () => {
      let lastErr;
      for (const playerId of PLAYER_IDS) {
        try { return await createClient(playerId); }
        catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('Unable to initialize YouTube client');
    })().catch(err => {
      ytPromise = null;
      throw err;
    });
  }
  return ytPromise;
}

function getVideoId(url) {
  const s = String(url || '').trim();
  const m = s.match(/(?:v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/watch\?.*v=)([A-Za-z0-9_-]{6,})/i);
  return m?.[1] || null;
}

function streamToBuffer(input, maxBytes) {
  const chunks = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    input.on('data', chunk => {
      const b = Buffer.from(chunk);
      total += b.length;
      if (total <= maxBytes) chunks.push(b);
      else {
        try { input.destroy(new Error('Downloaded audio is too large')); } catch {}
      }
    });
    input.on('end', () => resolve(Buffer.concat(chunks, Math.min(total, maxBytes))));
    input.on('error', reject);
  });
}

async function downloadWithYt(yt, id) {
  const attempts = [
    { type: 'audio', quality: 'best', format: 'webm', client: 'TV' },
    { type: 'audio', quality: 'best', format: 'mp4', client: 'TV' },
    { type: 'audio', quality: 'best', format: 'webm' },
    { type: 'audio', quality: 'best', format: 'any' }
  ];
  let lastErr;
  for (const opts of attempts) {
    try {
      const stream = await yt.download(id, opts);
      return (stream && typeof stream.getReader === 'function') ? Readable.fromWeb(stream) : stream;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('YouTube audio download failed');
}


async function downloadRemoteAudio(url, maxBytes = 35 * 1024 * 1024) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('Invalid audio URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36',
        'Accept': 'audio/mpeg,audio/*;q=0.9,*/*;q=0.5'
      }
    });
    if (!res.ok) throw new Error(`Audio provider returned HTTP ${res.status}`);
    const length = Number(res.headers.get('content-length') || 0);
    if (length > maxBytes) throw new Error('Audio file is too large');
    const chunks = [];
    let total = 0;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const b = Buffer.from(value);
        total += b.length;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new Error('Audio file is too large');
        }
        chunks.push(b);
      }
    } else {
      const b = Buffer.from(await res.arrayBuffer());
      if (b.length > maxBytes) throw new Error('Audio file is too large');
      chunks.push(b); total = b.length;
    }
    if (!total) throw new Error('Audio provider returned an empty file');
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}


async function fetchViaPublicApis(url) {
  const apis = [
    `https://apis.davidcyriltech.my.id/download/ytmp3?url=${encodeURIComponent(url)}`,
    `https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(url)}`,
    `https://yt-api.ooooo.su/api/downloader/youtube?url=${encodeURIComponent(url)}&format=mp3`
  ];
  let lastErr;
  for (const api of apis) {
    try {
      const axios = require('axios');
      const { data } = await axios.get(api, {
        timeout: 45000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const audioUrl =
        data?.result?.download_url ||
        data?.result?.url ||
        data?.result?.audio ||
        data?.data?.dl ||
        data?.data?.url ||
        data?.data?.download ||
        data?.url ||
        data?.download ||
        data?.link ||
        null;
      const title = data?.result?.title || data?.data?.title || data?.title || 'audio';
      if (audioUrl && String(audioUrl).startsWith('http')) {
        return { url: String(audioUrl), title: String(title) };
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All public YouTube MP3 APIs failed');
}

async function downloadMp3Url(url) {
  // 1) primary audio provider
  try {
    const result = await get_ytmp3(url);
    if (result?.url && String(result.url).startsWith('http')) {
      return { url: result.url, title: result.title || 'audio', provider: 'primary' };
    }
  } catch (e) {
    console.error('primary get_ytmp3 failed:', e?.message || e);
  }
  // 2) Public API fallbacks (same style as working ytmp3 in handler)
  const pub = await fetchViaPublicApis(url);
  return { ...pub, provider: 'public-api' };
}

async function downloadMp3(url, maxBytes = 30 * 1024 * 1024) {
  const id = getVideoId(url);
  if (!id) throw new Error('Invalid YouTube URL');

  const yt = await getYouTube();
  // getBasicInfo is enough for the title and avoids the heavier full-info parser.
  const info = await yt.getBasicInfo(id, { client: 'TV' });
  const title = info?.basic_info?.title || 'audio';
  const input = await downloadWithYt(yt, id);

  if (!input || typeof input.pipe !== 'function') throw new Error('YouTube returned no audio stream');

  const ff = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'mp3',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const chunks = [];
  let total = 0;
  let stderr = '';
  let killedForSize = false;
  ff.stderr.on('data', d => { stderr += d.toString(); });
  ff.stdout.on('data', chunk => {
    total += chunk.length;
    if (total <= maxBytes) chunks.push(chunk);
    else {
      killedForSize = true;
      ff.kill('SIGKILL');
    }
  });

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    const fail = err => { if (!settled) { settled = true; reject(err); } };
    ff.on('error', fail);
    input.on('error', fail);
    ff.on('close', code => {
      if (settled) return;
      if (killedForSize) return fail(new Error('Converted audio is too large for WhatsApp'));
      if (code !== 0) return fail(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
      if (!chunks.length) return fail(new Error('No audio data was produced'));
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    input.pipe(ff.stdin);
  });

  return { buffer: result, title };
}

async function searchYouTube(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const direct = getVideoId(q);
  if (direct) return { url: `https://www.youtube.com/watch?v=${direct}`, title: 'YouTube audio' };
  const yt = await getYouTube();
  const result = await yt.search(q, { type: 'video' });
  const item = (result?.results || []).find(v => v?.id || v?.video_id);
  if (!item) return null;
  const id = item.id || item.video_id;
  return { url: `https://www.youtube.com/watch?v=${id}`, title: item.title?.toString?.() || 'audio' };
}


async function searchYouTubeList(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) return [];
  const max = Math.min(Math.max(1, Number(limit) || 5), 10);
  try {
    const yts = require('yt-search');
    const res = await yts(q);
    return (res.videos || []).slice(0, max).map(v => ({
      id: v.videoId,
      url: v.url,
      title: v.title,
      artist: v.author?.name || v.author?.url || '',
      timestamp: v.timestamp || '',
      seconds: v.seconds || 0,
      views: v.views || 0,
      ago: v.ago || '',
      thumbnail: v.thumbnail || v.image || ''
    }));
  } catch (_) {}
  try {
    const yt = await getYouTube();
    const result = await yt.search(q, { type: 'video' });
    const items = (result?.results || []).slice(0, max);
    return items.map(item => {
      const id = item.id || item.video_id;
      return {
        id,
        url: id ? `https://www.youtube.com/watch?v=${id}` : '',
        title: item.title?.toString?.() || item.title || 'video',
        artist: item.author?.name || item.channel?.name || '',
        timestamp: '',
        seconds: 0,
        views: 0,
        ago: '',
        thumbnail: ''
      };
    }).filter(x => x.url);
  } catch (_) {
    return [];
  }
}

module.exports = { downloadMp3, downloadMp3Url, downloadRemoteAudio, getVideoId, searchYouTube, searchYouTubeList, fetchViaPublicApis };
