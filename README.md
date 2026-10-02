# 𝙅𝙄𝙉𝙓 𝙆9 V1.3.8

𝙅𝙄𝙉𝙓 𝙆9 V1.3.8 is a private, multi-session WhatsApp bot with a Telegram control panel.

## V1.3 highlights
- Session-isolated WhatsApp connections
- Persistent per-session runtime
- Session-scoped Owner/Sudo/Mod permissions
- Dynamic command registry and menu generation
- One authoritative command registry shared by execution and menu generation
- AI provider adapters for OpenAI, Gemini, DeepSeek, Mistral and Pollinations
- Reaction/sticker provider fallback
- `.doctor`, `.stats`, `.status`, `.system`, `.version`
- Keyboard-first Telegram control panel with Connect / Sessions / Status buttons
- Free access for every Telegram user; no trial or paid-access gate
- WhatsApp private mode defaults to private for new sessions
- Existing 𝙅𝙄𝙉𝙓 𝙆9 moderation, media, games and pairing features preserved

## Requirements
- Node.js 22+
- Telegram token and startup password are loaded from the private `config.env` file
- MongoDB is not required by this build; the existing file database remains the default.
- Optional AI environment variables:
  - `OPENAI_API_KEY`
  - `OPENAI_MODEL`
  - `MISTRAL_API_KEY`
  - `MISTRAL_MODEL`
  - `GEMINI_API_KEY`
  - `GEMINI_MODEL`
  - `DEEPSEEK_API_KEY`
  - `DEEPSEEK_MODEL`

## Start
```bash
npm run panel
```

The panel does not need a token or startup password prompt. Put `BOT_TOKEN` and `STARTUP_PASSWORD` in `config.env`; startup loads them automatically.

## WhatsApp diagnostics
- `.doctor` — checks 𝙅𝙄𝙉𝙓 𝙆9 core, session, database, WhatsApp, command registry, runtime and memory.
- `.stats` — session statistics.
- `.commands` — registered command counts by category.
- `.version` — 𝙅𝙄𝙉𝙓 𝙆9/Node/Baileys version.
- `.theme` / `.settheme prime|cyber|minimal` — theme preference.

## Session isolation
Every WhatsApp number gets its own authentication directory, runtime record, prefix, group settings and elevated permissions. A user authorized on one session is not automatically authorized on another session.

## Notes
Baileys 7.0.0-rc14 contains breaking changes and is ESM-based. 𝙅𝙄𝙉𝙓 𝙆9 keeps the CommonJS application architecture and loads Baileys through `lib/baileys.js`. See the official migration guidance before changing the Baileys version.
