// Baileys v7 is ESM-only. Keep 𝙅𝙄𝙉𝙓 𝙆9 CommonJS and load Baileys lazily.
let cached;
async function getBaileys() {
  if (!cached) cached = import('@whiskeysockets/baileys');
  return cached;
}
module.exports = { getBaileys };
