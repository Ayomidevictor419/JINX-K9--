const axios = require('axios');
const cheerio = require('cheerio');

async function searchWeb(query, limit = 6) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Search query is empty.');
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; JinxK9/1.0; +https://duckduckgo.com/)'
    }
  });
  const $ = cheerio.load(data);
  const results = [];
  $('.result').each((_, el) => {
    if (results.length >= limit) return;
    const a = $(el).find('.result__a').first();
    const title = a.text().trim();
    let href = a.attr('href') || '';
    const snippet = $(el).find('.result__snippet').text().trim();
    if (title && href) {
      if (href.startsWith('//')) href = 'https:' + href;
      results.push({ title, url: href, snippet });
    }
  });
  if (!results.length) throw new Error('No web results found. Try another search.');
  return results;
}

module.exports = { searchWeb };
