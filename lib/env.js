const fs = require('fs');
const path = require('path');

function loadEnvFile(file = path.resolve(process.cwd(), 'config.env')) {
  try {
    if (!fs.existsSync(file)) return false;
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!process.env[key]) process.env[key] = value;
    }
    process.env.CONFIG_ENV_LOADED = 'true';
    return true;
  } catch (e) {
    console.error('[env] Failed to load config.env:', e.message);
    return false;
  }
}

module.exports = { loadEnvFile };
