/**
 * Central response style for 𝙅𝙄𝙉𝙓 𝙆9.
 * Keeps bot replies concise, consistent and professional without changing
 * command semantics or AI/media output that explicitly opts into raw mode.
 */

const STATUS_PREFIX = /^[\s]*\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*(?:\s|$)/u;

function normalizeCommon(text) {
  let s = String(text ?? '').trim();
  if (!s) return s;

  const replacements = [
    [/^Access denied\.\s*Session Owner only\.?$/is, '🔒 This action is restricted to the session owner.'],
    [/^Access denied\.\s*Mod or higher required\.?$/is, '🔒 Mod or Owner permission is required for this action.'],
    [/^Access denied\.\s*Sudo or higher required\.?$/is, '🔒 Sudo or higher permission is required for this action.'],
    [/^Access denied\.\s*Owner or mod only\.?$/is, '🔒 Owner or Mod permission is required for this action.'],
    [/^Only admins or sudo\.?$/i, '🔒 A group admin or Sudo permission is required.'],
    [/^Only group admins or sudo can use this\.?$/i, '🔒 A group admin or Sudo permission is required.'],
    [/^Only group admins or sudo\.?$/i, '🔒 A group admin or Sudo permission is required.'],
    [/^Only admins or sudo\.?$/i, '🔒 A group admin or Sudo permission is required.'],
    [/^Only owner\/mod\/admin can toggle autodl\.?$/i, '🔒 Owner, Mod or group-admin permission is required for this setting.'],
    [/^Bot must be admin to delete muted messages\.?$/i, '⚠️ The bot must be a group admin to manage muted messages.'],
    [/^Bot must be admin to get invite link\.?$/i, '⚠️ The bot must be a group admin to retrieve the invite link.'],
    [/^I need to be admin to kick\.?$/i, '⚠️ The bot must be a group admin to remove members.'],
    [/^I need to be admin to kick\.?$/i, '⚠️ The bot must be a group admin to remove members.'],
    [/^You are not a group admin\. This is a group-admin-only command\.?$/i, '🔒 This action is restricted to WhatsApp group admins.'],
    [/^Bot must be admin\.?$/i, '⚠️ The bot must be a group admin to perform this action.'],
    [/^I need to be admin\.?$/i, '⚠️ The bot must be a group admin to perform this action.'],
    [/^I need to be admin to kick\.?$/i, '⚠️ The bot must be a group admin to remove members.'],
    [/^No members found\.?$/i, 'ℹ️ No group members were found.'],
    [/^No members to kick\.?$/i, 'ℹ️ There are no eligible members to remove.'],
    [/^No valid targets to kick\.?$/i, 'ℹ️ No valid members were selected for removal.'],
    [/^No matching sudo user was found\.?$/i, 'ℹ️ No matching Sudo record was found for the selected user.'],
    [/^No matching mod user was found\.?$/i, 'ℹ️ No matching Mod record was found for the selected user.'],
    [/^User\(s\) already sudo\/mod, or invalid target\.?$/i, 'ℹ️ No new Sudo access was granted. The target may already have elevated access or may be invalid.'],
    [/^User\(s\) already mod, or invalid target\.?$/i, 'ℹ️ No new Mod access was granted. The target may already be a Mod or may be invalid.'],
    [/^Group is already muted\.?$/i, 'ℹ️ The group is already muted.'],
    [/^Group is already unmuted\.?$/i, 'ℹ️ The group is already open.'],
    [/^Group is muted\.?$/i, '🔇 Group muted successfully.'],
    [/^Group is unmuted\.?$/i, '🔊 Group unmuted successfully.'],
    [/^This command can only be used in groups\.?$/i, '🔒 This command is available in WhatsApp groups only.'],
    [/^This command can only be used in private chat\.?$/i, '🔒 This command is available in private chat only.'],
    [/^Please wait\.\.\.?$/i, '⏳ Please wait a moment.'],
    [/^Done\.?$/i, '✅ Completed successfully.'],
    [/^Something went wrong\. Try again\.?$/i, '❌ Something went wrong. Please try again.'],
    [/^Group is muted for (.+)$/i, (_, duration) => `🔇 Group muted successfully for ${duration}`],
    [/^Kicked: (.+)$/i, (_, targets) => `🛡️ Members removed successfully: ${targets}`],
    [/^Promoted: (.+)$/i, (_, targets) => `🛡️ Admin access granted to: ${targets}`],
    [/^Demoted: (.+)$/i, (_, targets) => `🛡️ Admin access removed from: ${targets}`],
    [/^(.+) has been warned \((\d+\/\d+)\)(.*)$/i, (_, user, count, reason) => `⚠️ ${String(user).replace(/^⚠️\s*/, '')} · warning ${count}${reason || ''}`],
  ];

  for (const [pattern, replacement] of replacements) {
    const match = s.match(pattern);
    if (match) return typeof replacement === 'function' ? replacement(...match) : replacement;
  }
  return s;
}

function addStatusIfNeeded(text) {
  const s = String(text ?? '').trim();
  if (!s || STATUS_PREFIX.test(s)) return s;
  if (/^(failed|error|could not|unable|invalid|no matching|not found|cannot|can't)\b/i.test(s)) return `❌ ${s}`;
  if (/^(warning|warn|blocked|restricted|you cannot|only )\b/i.test(s)) return `⚠️ ${s}`;
  if (/^(success|completed|added|removed|granted|updated|enabled|disabled|promoted|demoted|kicked|muted|unmuted|saved|set)\b/i.test(s)) return `✅ ${s}`;
  return `ℹ️ ${s}`;
}

function professionalize(text, { raw = false } = {}) {
  if (raw) return String(text ?? '');
  const normalized = normalizeCommon(text);
  if (!normalized) return normalized;
  return addStatusIfNeeded(normalized);
}

function action(kind, text) {
  const body = String(text ?? '').trim();
  if (!body) return body;
  const prefix = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
    mute: '🔇',
    unmute: '🔊',
    security: '🔒',
    moderation: '🛡️'
  }[kind] || 'ℹ️';
  return STATUS_PREFIX.test(body) ? body : `${prefix} ${body}`;
}

module.exports = { professionalize, action };
