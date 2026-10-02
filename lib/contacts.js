const cache = new Map();

function rememberContacts(sessionId, contacts = []) {
  if (!cache.has(sessionId)) cache.set(sessionId, new Map());
  const map = cache.get(sessionId);
  for (const c of contacts || []) {
    const id = c?.id;
    if (!id) continue;
    const name = c.name || c.notify || c.verifiedName || c.shortName;
    if (!name) continue;
    map.set(String(id), String(name));
    if (c.phoneNumber) map.set(String(c.phoneNumber), String(name));
    if (c.lid) map.set(String(c.lid), String(name));
  }
}

function getContactName(sessionId, jid) {
  return cache.get(sessionId)?.get(String(jid)) || '';
}

function clearSession(sessionId) {
  cache.delete(sessionId);
}

module.exports = { rememberContacts, getContactName, clearSession };
