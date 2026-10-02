# 𝙅𝙄𝙉𝙓 𝙆9 — Safety / Backup / Rollback

## Source backup

Keep the previously deployed JINX K9 package as a separate backup. Do not overwrite your only working copy.

## Before deployment

1. Stop the current bot.
2. Copy the entire deployed bot folder to a backup folder.
3. Back up these runtime folders/files separately:
   - `database/`
   - `sessions/`
   - `config.env`
4. Deploy the new source only after the backup is complete.

Example:

```bash
cp -a JINX-K9-WORKING JINX-K9-BACKUP-BEFORE-V1.3.8
```

For an existing deployment, preserve its `database/` and `sessions/` directories unless you intentionally want to reset them.

## What this update changes

- Session-scoped sudo/mod identity handling
- Private/public mode authorization
- Default private mode for newly connected sessions
- Canonical `.sudo`, `.delsudo`, `.mod`, `.delmod`, `.mode` command implementations
- Short dynamic `.ping`
- Command/menu consolidation
- Keyboard-first Telegram control panel
- Permanent free Telegram access
- Removal of the old trial/premium access gate
- Cleaner pairing notifications

## Database safety

The updated database code keeps the existing `database/elevated.json` structure compatible while adding an `identityMap` used to connect verified equivalent WhatsApp identities.

Do not manually delete `database/elevated.json` unless you intentionally want to remove all sudo/mod assignments.

## Session safety

WhatsApp authentication remains under:

```text
./sessions/
```

The update does not intentionally delete existing authentication credentials.

## Rollback

If the updated build causes a problem:

```bash
# Stop the bot first
rm -rf JINX-K9-WORKING
unzip -o <previous-working-jinx-k9-backup>.zip -d JINX-K9-WORKING
```

Then restore the backed-up runtime data:

```bash
cp -a JINX-K9-BACKUP-BEFORE-V1.3.8/database ./JINX-K9-WORKING/
cp -a JINX-K9-BACKUP-BEFORE-V1.3.8/sessions ./JINX-K9-WORKING/
```

Restore `config.env` from the deployment backup if it was changed. Keep `config.env` private because it contains deployment secrets.

## Verification after deployment

Confirm:

- `.ping` returns one short `🏓 Pong! Xms` message.
- Unauthorized users get no response in private mode.
- `.sudo @user` grants access.
- `.delsudo @user` immediately removes access.
- `.mod @user` and `.delmod @user` behave the same way.
- `.mode private` and `.mode public` remain session-scoped.
- Telegram `/start` opens the button-based control panel.
- Connect asks for the WhatsApp number, shows the pairing code, and finally reports `Number connected`.
