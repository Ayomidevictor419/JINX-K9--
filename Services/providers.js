const axios = require('axios');

async function fetchJson(url, opts = {}) {
  const res = await axios.get(url, {
    timeout: opts.timeout || 12000,
    responseType: opts.responseType || 'json',
    headers: opts.headers || { 'User-Agent': 'Jinx-K9-MD/9.0' }
  });
  return res.data;
}

const WAIFU_MAP = {
  slap:'slap', hug:'hug', kiss:'kiss', pat:'pat', cuddle:'cuddle', tickle:'tickle',
  feed:'nom', smug:'smug', bully:'bully', cry:'cry', highfive:'highfive', handhold:'handhold',
  bite:'bite', lick:'lick', kill:'kill', dance:'dance', wink:'wink', poke:'poke', bonk:'bonk',
  yeet:'yeet', blush:'blush', smile:'happy', wave:'wave', happy:'happy', sad:'cry', angry:'bully',
  cringe:'baka', neko:'neko', waifu:'waifu', foxgirl:'fox_girl', wallpaper:'wallpaper',
  ngif:'ngif', meow:'meow', woof:'woof', goose:'goose', lizard:'lizard'
};


let nekosEndpointsCache = null;
let nekosEndpointsAt = 0;
async function getNekosEndpoints() {
  if (nekosEndpointsCache && Date.now() - nekosEndpointsAt < 10 * 60 * 1000) return nekosEndpointsCache;
  const data = await fetchJson('https://nekos.best/api/v2/endpoints', { timeout: 10000, headers: { 'User-Agent': 'Jinx-K9-MD/9.0 (fun provider)' } });
  nekosEndpointsCache = new Set(Object.keys(data || {}));
  nekosEndpointsAt = Date.now();
  return nekosEndpointsCache;
}

const NEKOS_MAP = {
  slap:'slap', hug:'hug', kiss:'kiss', pat:'pat', cuddle:'cuddle', tickle:'tickle',
  feed:'feed', smug:'smug', bully:'angry', cry:'cry', highfive:'highfive', bite:'bite',
  lick:'lick', kill:'punch', dance:'dance', wink:'wink', poke:'poke', bonk:'baka',
  yeet:'yeet', blush:'blush', smile:'smile', wave:'wave', happy:'smile', sad:'cry',
  angry:'angry', cringe:'baka', neko:'neko', waifu:'waifu', foxgirl:'foxgirl',
  meow:'meow', woof:'woof', goose:'goose', lizard:'lizard'
};

async function fetchReaction(category) {
  const action = String(category || '').toLowerCase();
  const waifuCategory = WAIFU_MAP[action] || action;
  const attempts = [
    async () => {
      const data = await fetchJson(`https://api.waifu.pics/sfw/${encodeURIComponent(waifuCategory)}`, { timeout: 10000, headers: { 'User-Agent': 'Jinx-K9-MD/9.0' } });
      return data?.url;
    },
    async () => {
      const data = await fetchJson(`https://api.waifu.pics/many/sfw/${encodeURIComponent(waifuCategory)}`, { timeout: 10000, headers: { 'User-Agent': 'Jinx-K9-MD/9.0' } });
      return Array.isArray(data?.files) ? data.files.find(Boolean) : null;
    },
    async () => {
      const nekoCategory = NEKOS_MAP[action] || action;
      const supported = await getNekosEndpoints();
      if (!supported.has(nekoCategory)) throw new Error(`NekosBest category not supported: ${nekoCategory}`);
      const data = await fetchJson(`https://nekos.best/api/v2/${encodeURIComponent(nekoCategory)}`, { timeout: 12000, headers: { 'User-Agent': 'Jinx-K9-MD/9.0 (fun provider)' } });
      return data?.results?.[0]?.url;
    }
  ];
  let last;
  for (const attempt of attempts) {
    try {
      const url = await attempt();
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
    } catch (e) { last = e; }
  }
  throw last || new Error(`No working reaction provider for ${action}`);
}

async function fetchReactionMedia(category) {
  const url = await fetchReaction(category);
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 25000,
    maxContentLength: 30 * 1024 * 1024,
    maxBodyLength: 30 * 1024 * 1024,
    headers: { 'User-Agent': 'Jinx-K9-MD/9.0', Accept: '*/*' }
  });
  return { url, buffer: Buffer.from(res.data), contentType: String(res.headers?.['content-type'] || '').toLowerCase() };
}

module.exports = { fetchJson, fetchReaction, fetchReactionMedia };
