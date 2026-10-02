/**
 * Centralized WhatsApp identity resolution for 𝙅𝙄𝙉𝙓 𝙆9.
 * A phone JID and its LID are representations of one logical user when
 * WhatsApp provides a reliable mapping. Permission code must never treat
 * those representations as separate users.
 */

function clean(value) { return String(value || '').trim(); }

function elevVariants(jid) {
  const s = clean(jid);
  if (!s) return new Set();
  const out = new Set([s]);
  const lower = s.toLowerCase();
  const n = s.replace(/[^0-9]/g, '');
  if (lower.endsWith('@lid')) {
    if (n) out.add(`${n}@lid`);
    return out;
  }
  if (lower.endsWith('@s.whatsapp.net') || lower.endsWith('@c.us')) {
    if (n) {
      out.add(`${n}@s.whatsapp.net`);
      out.add(`${n}@c.us`);
    }
    return out;
  }
  if (/^\d{8,15}$/.test(s)) {
    out.add(`${s}@s.whatsapp.net`);
    out.add(`${s}@c.us`);
  }
  return out;
}

function canonicalIdentity(jid) {
  const s = clean(jid).toLowerCase();
  if (!s) return '';
  if (s.endsWith('@lid')) return `lid:${s}`;
  const n = s.replace(/[^0-9]/g, '');
  if (s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us') || /^\d{8,15}$/.test(s)) {
    return n.length >= 8 && n.length <= 15 ? `pn:${n}` : '';
  }
  return '';
}

async function resolvePhoneJid(sock, jid, participants = []) {
  const raw = clean(jid);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.endsWith('@s.whatsapp.net') || lower.endsWith('@c.us')) {
    const n = raw.replace(/[^0-9]/g, '');
    return n ? `${n}@s.whatsapp.net` : null;
  }
  try {
    for (const p of participants || []) {
      const ids = [p?.id, p?.jid, p?.lid, p?.phoneNumber, p?.pn].filter(Boolean).map(String);
      if (!ids.some(id => identitiesMatch(id, raw))) continue;
      const pn = ids.find(v => /@(s\.whatsapp\.net|c\.us)$/i.test(v)) ||
        (String(p?.phoneNumber || p?.pn || '').match(/^\d{8,15}$/) ? `${p.phoneNumber || p.pn}@s.whatsapp.net` : null);
      if (pn) { const n = String(pn).replace(/[^0-9]/g, ''); if (n) return `${n}@s.whatsapp.net`; }
    }
  } catch (_) {}
  if (lower.endsWith('@lid')) {
    try {
      const mapped = await sock?.signalRepository?.lidMapping?.getPNForLID?.(raw);
      if (mapped) {
        const n = String(mapped).replace(/[^0-9]/g, '');
        if (n.length >= 8 && n.length <= 15) return `${n}@s.whatsapp.net`;
      }
    } catch (_) {}
  }
  return null;
}

function getTargetJids(m, args = []) {
  const ctx =
    m?.message?.extendedTextMessage?.contextInfo ||
    m?.message?.imageMessage?.contextInfo ||
    m?.message?.videoMessage?.contextInfo ||
    m?.message?.stickerMessage?.contextInfo ||
    m?.message?.documentMessage?.contextInfo || {};
  const targets = new Set();
  for (const j of ctx.mentionedJid || []) if (j) targets.add(String(j));
  if (ctx.participant) targets.add(String(ctx.participant));
  for (const a of args || []) {
    const raw = clean(a);
    if (!raw || raw.toLowerCase() === 'admins') continue;
    if (/^@?\d{8,15}$/.test(raw)) {
      const n = raw.replace(/[^0-9]/g, '');
      targets.add(`${n}@s.whatsapp.net`);
    } else if (raw.includes('@')) {
      targets.add(raw.replace(/^@(?=\d)/, ''));
    } else {
      const n = raw.replace(/[^0-9]/g, '');
      if (/^\d{8,15}$/.test(n)) targets.add(`${n}@s.whatsapp.net`);
    }
  }
  return [...targets];
}

function identitiesMatch(a, b) {
  const ca = canonicalIdentity(a);
  const cb = canonicalIdentity(b);
  return !!ca && !!cb && ca === cb;
}

function participantRaw(value) {
  if (!value) return '';
  if (typeof value === 'string') return clean(value);
  if (typeof value === 'object') {
    for (const key of ['phoneNumber', 'pn', 'id', 'jid', 'lid', 'participant']) {
      if (value[key]) return clean(value[key]);
    }
  }
  return clean(value);
}

async function normalizeParticipantJid(sock, value, participants = []) {
  const raw = participantRaw(value);
  if (!raw || raw === '[object Object]') return null;
  const directPhone = raw.match(/^(\d{8,15})@(s\.whatsapp\.net|c\.us)$/i);
  if (directPhone) return `${directPhone[1]}@s.whatsapp.net`;
  const resolved = await resolvePhoneJid(sock, raw, participants);
  if (resolved) return resolved;
  if (/@lid$/i.test(raw)) return raw;
  if (/^\d{8,15}$/.test(raw)) return `${raw}@s.whatsapp.net`;
  return raw;
}

function participantIds(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'object') {
    return ['phoneNumber', 'pn', 'id', 'jid', 'lid', 'participant']
      .map(k => value[k]).filter(Boolean).map(String);
  }
  return [String(value)];
}

async function resolveSenderIdentities(sock, senderCandidates = [], participants = []) {
  const out = new Set();
  for (const candidate of senderCandidates || []) {
    const raw = clean(candidate);
    if (!raw) continue;
    for (const form of elevVariants(raw)) out.add(form);
    const resolved = await resolvePhoneJid(sock, raw, participants);
    if (resolved) for (const form of elevVariants(resolved)) out.add(form);
  }
  return [...out];
}

async function resolveElevatedTargets(sock, m, args, participants = []) {
  const first = clean(args?.[0]).toLowerCase();
  if (first === 'admins') {
    const out = [];
    for (const p of participants || []) {
      if (!p?.admin) continue;
      const base = p.id || p.jid || p.lid;
      const resolved = (await resolvePhoneJid(sock, base, participants)) || base;
      if (resolved) out.push(resolved);
    }
    return [...new Set(out)];
  }
  const out = [];
  for (const raw of getTargetJids(m, args)) {
    const resolved = (await resolvePhoneJid(sock, raw, participants)) || raw;
    if (resolved) out.push(resolved);
  }
  return [...new Set(out)];
}

async function expandIdentityForms(sock, jid, participants = []) {
  const forms = new Set();
  for (const v of elevVariants(jid)) forms.add(v);
  const resolved = await resolvePhoneJid(sock, jid, participants);
  if (resolved) for (const v of elevVariants(resolved)) forms.add(v);
  return [...forms];
}

module.exports = { elevVariants, canonicalIdentity, identitiesMatch, participantRaw, participantIds, normalizeParticipantJid, getTargetJids, resolvePhoneJid, resolveSenderIdentities, resolveElevatedTargets, expandIdentityForms };
