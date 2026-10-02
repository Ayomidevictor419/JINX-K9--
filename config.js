module.exports = {
  // ==================== BOT IDENTITY ====================
  BOT_NAME: '𝙅𝙄𝙉𝙓 𝙆9',
  VERSION: '1.3.8',
  BOT_USERNAME: 'Zeusmdbot',
  OWNER_NAME: 'PRIME',
  OWNER_TELEGRAM: '@IamPrime479',
  OWNER_TELEGRAM_ID: '6693499462',

  // Developer WhatsApp numbers (shown in .owner command only; sessions remain isolated)
  OWNER_NUMBERS: [
    '2349169506858',
    '2349036572847'
  ],

  // Default prefix for new WhatsApp connections
  DEFAULT_PREFIX: '.',

  // Group invite sent to every newly connected WhatsApp
  GROUP_INVITE: 'https://chat.whatsapp.com/Eoerg3VIaxv9X0jXTRrJEt',
  // Session storage
  SESSIONS_DIR: './sessions',
  DATABASE_DIR: './database',

  // Messages
  MESSAGES: {
    onlyOwner: '🔒 This action is restricted to the session owner.',
    onlyMod: '🔒 Mod or Owner permission is required for this action.',
    onlySudo: '🔒 Sudo or higher permission is required for this action.',
    onlyGroup: '🔒 This command is available in WhatsApp groups only.',
    onlyPrivate: '🔒 This command is available in private chat only.',
    wait: '⏳ Please wait a moment.',
    success: '✅ Completed successfully.',
    error: '❌ Something went wrong. Please try again.'
  }
};
