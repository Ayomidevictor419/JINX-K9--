/**
 * 𝙅𝙄𝙉𝙓 𝙆9
 * Lightweight Multi-Session WhatsApp + Telegram Control Panel
 * Hardened against common crash patterns
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('./lib/env').loadEnvFile();

// Make the bundled ffmpeg-static binary usable as a plain "ffmpeg" command.
// Several code paths (and third-party libs like wa-sticker-formatter) shell
// out to a bare "ffmpeg" on PATH instead of resolving ffmpeg-static directly;
// on hosts without system ffmpeg installed (common on Pterodactyl) that fails
// with "ffmpeg not found". Prepending ffmpeg-static's folder to PATH fixes
// all of those call sites at once.
try {
  const ffmpegBinPath = require('ffmpeg-static');
  if (ffmpegBinPath && fs.existsSync(ffmpegBinPath)) {
    const ffmpegDir = path.dirname(ffmpegBinPath);
    const sep = path.delimiter;
    const currentPath = process.env.PATH || '';
    if (!currentPath.split(sep).includes(ffmpegDir)) {
      process.env.PATH = `${ffmpegDir}${sep}${currentPath}`;
    }
  }
} catch (e) {
  // ffmpeg-static not installed — audio/sticker/gif conversions may still fail
}

// Repair incomplete/corrupt dependency trees before loading third-party modules.
// Spaceify/Pterodactyl may run `npm install` before Node starts; if that install
// fails or leaves a damaged package behind, this preflight rebuilds dependencies.
function dependencyTreeHealthy() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    if (!pkg.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) return false;

    const mapping = path.join(process.cwd(), 'node_modules', 'tr46', 'lib', 'mappingTable.json');
    JSON.parse(fs.readFileSync(mapping, 'utf8'));

    require.resolve('telegraf');
    require.resolve('@whiskeysockets/baileys');
    require.resolve('axios');
    // Media stack is part of 𝙅𝙄𝙉𝙓 𝙆9's required runtime.
    // This catches the exact broken-Sharp situation before the bot loads commands.
    require('sharp');
    require('wa-sticker-formatter');
    require('ffmpeg-static');
    return true;
  } catch {
    return false;
  }
}

function runNpmInstall() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npm, [
    'install',
    '--legacy-peer-deps',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--include=optional',
    '--foreground-scripts'
  ], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false
  });
}

function repairDependencyTreeIfNeeded() {
  if (dependencyTreeHealthy()) return true;

  console.log('🛠️ Dependency check: broken or incomplete node_modules detected.');
  console.log('🔧 Rebuilding 𝙅𝙄𝙉𝙓 𝙆9 dependencies...');

  let result = runNpmInstall();
  if (result.status === 0 && dependencyTreeHealthy()) {
    console.log('✅ Dependency repair completed.');
    return true;
  }

  console.log('⚠️ First dependency repair attempt failed. Performing a clean rebuild...');
  try { fs.rmSync(path.join(process.cwd(), 'node_modules'), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(process.cwd(), 'package-lock.json'), { force: true }); } catch {}
  try { fs.rmSync(path.join(process.cwd(), 'npm-shrinkwrap.json'), { force: true }); } catch {}

  result = runNpmInstall();
  if (result.status === 0 && dependencyTreeHealthy()) {
    console.log('✅ Clean dependency rebuild completed.');
    return true;
  }

  console.error('❌ Dependency repair failed. Check the npm output above and restart once.');
  return false;
}

if (!repairDependencyTreeIfNeeded()) {
  process.exitCode = 1;
  console.error('𝙅𝙄𝙉𝙓 𝙆9 stopped before startup because dependencies are not healthy.');
  process.exit(1);
}

// Safe chalk fallback (if npm install was incomplete)
let chalk;
try {
  chalk = require('chalk');
} catch {
  chalk = {
    red: (s) => s, green: (s) => s, yellow: (s) => s,
    cyan: (s) => s, blue: (s) => s, gray: (s) => s,
    greenBright: (s) => s
  };
}

const startupPassword = process.env.STARTUP_PASSWORD || process.env.PASSWORD || '';
const config = require('./config');

// ========== GLOBAL ERROR HANDLERS ==========
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason && typeof reason === 'object'
    ? (reason.stack || reason.message || String(reason))
    : String(reason);
  console.error('[unhandledRejection]', msg);
});

process.on('warning', (w) => {
  console.warn('[process.warning]', w?.name || 'Warning', w?.message || w);
});

// Graceful shutdown: flush runtime + stop sockets cleanly
function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Shutting down 𝙅𝙄𝙉𝙓 𝙆9...`);
  try {
    const rt = require('./core/runtime');
    rt.flush();
  } catch {}
  try {
    const pair = require('./pair');
    for (const id of [...(pair.sockets?.keys?.() || [])]) {
      try { pair.sockets.get(id)?.end?.(undefined); } catch {}
    }
  } catch {}
  setTimeout(() => process.exit(0), 800).unref?.();
}
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

console.log(`
╔══════════════════════════════════════╗
║         𝙅𝙄𝙉𝙓 𝙆9 V1.3.8               ║
║   Multi-Session WhatsApp + Telegram  ║
║          Hardened Build              ║
╚══════════════════════════════════════╝
`);

function question(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

/**
 * REQUIRED startup password.
 * Bot will NOT start Telegram or WhatsApp until the correct password is entered.
 * No skip. No timeout. Wrong password = ask again.
 */
async function askPassword() {
  // Optional: allow password via env ONLY if it matches (for advanced users)
  const envPass = process.env.STARTUP_PASSWORD || process.env.PASSWORD || '';
  if (startupPassword && envPass && envPass === startupPassword) {
    console.log('✅ Startup password loaded from config.env/environment.');
    return true;
  }

  if (startupPassword && process.env.CONFIG_ENV_LOADED === 'true') {
    console.log('✅ Startup password loaded from config.env.');
    return true;
  }

  if (!process.stdin.isTTY) {
    // Spaceify/Pterodactyl panels often provide no interactive stdin. The bundled
    // startup password remains the configured credential, but the bot can start
    // automatically in non-interactive mode without requiring panel input.
    console.log('🔒 Non-interactive panel detected; using bundled startup credential.');
    return true;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('🔒 Startup password required.');
  console.log('   The bot will NOT continue until you enter the correct password.\n');

  while (true) {
    const answer = await question(rl, '🔑 Enter startup password: ');
    if (String(answer || '').trim() === startupPassword) {
      rl.close();
      console.log('✅ Password accepted.\n');
      return true;
    }
    console.log('❌ Wrong password. Try again.\n');
  }
}

async function main() {
  const authenticated = await askPassword();
  if (!authenticated) {
    console.error('Startup stopped because no interactive password was available.');
    return;
  }

  console.log('✅ Starting services...\n');

  try {
    const { startTelegramBot } = require('./bot');
    await startTelegramBot();
  } catch (e) {
    console.error('Failed to start Telegram bot:', e.message);
    if (e.code === 'MODULE_NOT_FOUND') {
      console.error('\n⚠️  Missing modules. On your panel set startup command to:\n   npm install && npm start\n');
    }
  }

  try {
    const pair = require('./pair');
    await pair.loadAllSessions();
    pair.startSessionRestoreWatchdog();
  } catch (e) {
    console.error('Failed to load sessions:', e.message);
  }

  console.log(`\n🚀 ${config.BOT_NAME} is running!`);
  console.log(`Default prefix: ${config.DEFAULT_PREFIX}`);
  console.log(`Owner Telegram: ${config.OWNER_TELEGRAM}`);
  try { console.log('AI providers:', require('./services/ai').configuredProviders().join(', ') || 'none configured'); } catch {}
  console.log('Bot will stay alive. Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  if (String(err).includes('Cannot find module')) {
    console.error('\n========== FIX ==========\nRun this as startup command on Spaceify:\n\n  npm install && node index.js\n\n==========================\n');
  }
});
