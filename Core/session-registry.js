// Runtime registry of connected Matrix WhatsApp identities.
// This is ONLY used to prevent one Matrix session from reacting to another
// Matrix session's messages. Permissions/settings remain session-scoped elsewhere.
const sessions = new Map(); // sessionId -> Set(identity variants)

function variants(value) {
  const s = String(value || '').trim();
  if (!s) return [];
  const out = new Set([s]);
  const base = s.split(':')[0];
  if (base && base !== s) out.add(base);

  if (s.endsWith('@s.whatsapp.net')) {
    const n = s.split('@')[0].replace(/[^0-9]/g, '');
    if (n) {
      out.add(n);
      out.add(`${n}@s.whatsapp.net`);
    }
  }
  // LIDs are opaque identifiers: never convert them into phone numbers.
  if (s.endsWith('@lid')) out.add(s);
  return [...out];
}

function register(sessionId, identities = []) {
  const key = String(sessionId || '').trim();
  if (!key) return;
  const set = new Set();
  for (const identity of identities) {
    for (const v of variants(identity)) set.add(v);
  }
  sessions.set(key, set);
}

function add(sessionId, identities = []) {
  const key = String(sessionId || '').trim();
  if (!key) return;
  if (!sessions.has(key)) sessions.set(key, new Set());
  const set = sessions.get(key);
  for (const identity of identities) {
    for (const v of variants(identity)) set.add(v);
  }
}

function unregister(sessionId) {
  sessions.delete(String(sessionId || '').trim());
}

function isFromOtherSession(currentSessionId, candidateJids = []) {
  const current = String(currentSessionId || '').trim();
  const candidates = new Set();
  for (const candidate of candidateJids) {
    for (const v of variants(candidate)) candidates.add(v);
  }
  if (!candidates.size) return false;

  for (const [sessionId, identities] of sessions.entries()) {
    if (sessionId === current) continue;
    for (const candidate of candidates) {
      if (identities.has(candidate)) return true;
    }
  }
  return false;
}

function getSnapshot() {
  return [...sessions.entries()].map(([sessionId, identities]) => ({
    sessionId,
    identities: [...identities]
  }));
}

module.exports = { register, add, unregister, isFromOtherSession, getSnapshot };
