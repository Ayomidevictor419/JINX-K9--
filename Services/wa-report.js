/**
 * Report a WhatsApp user/group via connected sessions.
 * Returns per-method attempt details so Telegram can show what actually happened.
 */
const fs = require('fs-extra');
const path = require('path');

function errText(e) {
  if (!e) return 'unknown';
  if (typeof e === 'string') return e;
  const parts = [];
  if (e.message) parts.push(e.message);
  if (e.output) {
    try { parts.push(JSON.stringify(e.output).slice(0, 200)); } catch (_) {}
  }
  if (e.data) {
    try { parts.push(JSON.stringify(e.data).slice(0, 200)); } catch (_) {}
  }
  if (e.status || e.statusCode) parts.push('status=' + (e.status || e.statusCode));
  return parts.join(' | ') || String(e);
}

/**
 * Try every known report path on one socket.
 * Always returns full attempts[] even when one succeeds.
 */
async function reportViaSocket(sock, targetJid, reason = 'spam') {
  if (!sock) {
    return {
      ok: false,
      jid: String(targetJid || ''),
      method: null,
      attempts: [{ method: 'session', ok: false, detail: 'WhatsApp session offline / no socket' }],
      errors: ['session offline']
    };
  }

  let jid = String(targetJid || '');
  const num = jid.replace(/[^0-9]/g, '');
  if (!jid.includes('@')) jid = num + '@s.whatsapp.net';

  const attempts = [];
  let resolved = false;
  try {
    const ow = await sock.onWhatsApp(jid);
    const hit = Array.isArray(ow) ? ow[0] : ow;
    if (hit?.jid) {
      jid = hit.jid;
      resolved = !!hit.exists || !!hit.jid;
      attempts.push({
        method: 'onWhatsApp',
        ok: true,
        detail: `resolved → ${jid}` + (hit.exists === false ? ' (may not be on WA)' : '')
      });
    } else {
      attempts.push({ method: 'onWhatsApp', ok: false, detail: 'no jid returned; using ' + jid });
    }
  } catch (e) {
    attempts.push({ method: 'onWhatsApp', ok: false, detail: errText(e) });
  }

  let finalMethod = null;
  let finalOk = false;

  // --- 1) Native reportSpam ---
  if (typeof sock.reportSpam === 'function') {
    try {
      let res;
      try {
        res = await sock.reportSpam(jid, { reason: String(reason).slice(0, 500) });
      } catch (_) {
        res = await sock.reportSpam(jid);
      }
      finalOk = true;
      finalMethod = 'reportSpam';
      attempts.push({
        method: 'reportSpam',
        ok: true,
        detail: res != null ? `returned ${typeof res === 'object' ? JSON.stringify(res).slice(0, 120) : String(res)}` : 'accepted (no error)'
      });
    } catch (e) {
      attempts.push({ method: 'reportSpam', ok: false, detail: errText(e) });
    }
  } else {
    attempts.push({ method: 'reportSpam', ok: false, detail: 'not available on this Baileys build' });
  }

  // --- 2) IQ xmlns=spam ---
  if (!finalOk && typeof sock.query === 'function') {
    // with reason node
    try {
      const res = await sock.query({
        tag: 'iq',
        attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'spam' },
        content: [{
          tag: 'spam_list',
          attrs: {
            type: jid.endsWith('@g.us') ? 'group' : 'contacts',
            jid: jid.split(':')[0]
          },
          content: [{ tag: 'reason', attrs: {}, content: String(reason).slice(0, 500) }]
        }]
      });
      finalOk = true;
      finalMethod = 'iq-spam+reason';
      attempts.push({
        method: 'iq-spam+reason',
        ok: true,
        detail: res ? `iq ok tag=${res.tag || '?'} attrs=${JSON.stringify(res.attrs || {}).slice(0, 100)}` : 'iq returned empty (often still means sent)'
      });
    } catch (e) {
      attempts.push({ method: 'iq-spam+reason', ok: false, detail: errText(e) });
      // without reason
      try {
        const res2 = await sock.query({
          tag: 'iq',
          attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'spam' },
          content: [{
            tag: 'spam_list',
            attrs: {
              type: jid.endsWith('@g.us') ? 'group' : 'contacts',
              jid: jid.split(':')[0]
            }
          }]
        });
        finalOk = true;
        finalMethod = 'iq-spam';
        attempts.push({
          method: 'iq-spam',
          ok: true,
          detail: res2 ? `iq ok tag=${res2.tag || '?'}` : 'iq returned empty (often still means sent)'
        });
      } catch (e2) {
        attempts.push({ method: 'iq-spam', ok: false, detail: errText(e2) });
      }
    }
  } else if (typeof sock.query !== 'function') {
    attempts.push({ method: 'iq-spam', ok: false, detail: 'sock.query not available' });
  }

  // --- 3) sendNode xmlns=w:spam ---
  if (!finalOk && typeof sock.sendNode === 'function') {
    try {
      await sock.sendNode({
        tag: 'iq',
        attrs: {
          id: (typeof sock.generateMessageTag === 'function' ? sock.generateMessageTag() : String(Date.now())),
          to: 's.whatsapp.net',
          type: 'set',
          xmlns: 'w:spam'
        },
        content: [{
          tag: 'spam_list',
          attrs: {
            type: jid.endsWith('@g.us') ? 'group' : 'contacts',
            jid: jid.split(':')[0]
          }
        }]
      });
      finalOk = true;
      finalMethod = 'sendNode-w:spam';
      attempts.push({ method: 'sendNode-w:spam', ok: true, detail: 'node sent (no throw)' });
    } catch (e) {
      attempts.push({ method: 'sendNode-w:spam', ok: false, detail: errText(e) });
    }
  } else if (typeof sock.sendNode !== 'function') {
    attempts.push({ method: 'sendNode-w:spam', ok: false, detail: 'sock.sendNode not available' });
  }

  // --- 4) Alternate xmlns report ---
  if (!finalOk && typeof sock.query === 'function') {
    try {
      await sock.query({
        tag: 'iq',
        attrs: { to: jid.split(':')[0], type: 'set', xmlns: 'w:spamReport' },
        content: [{ tag: 'spamReport', attrs: { type: 'spam' } }]
      });
      finalOk = true;
      finalMethod = 'iq-w:spamReport';
      attempts.push({ method: 'iq-w:spamReport', ok: true, detail: 'iq ok' });
    } catch (e) {
      attempts.push({ method: 'iq-w:spamReport', ok: false, detail: errText(e) });
    }
  }

  const errors = attempts.filter(a => !a.ok).map(a => `${a.method}: ${a.detail}`);

  return {
    ok: finalOk,
    jid,
    method: finalMethod,
    attempts,
    errors,
    baileysHasReportSpam: typeof sock.reportSpam === 'function',
    baileysHasQuery: typeof sock.query === 'function',
    baileysHasSendNode: typeof sock.sendNode === 'function'
  };
}

function logReport(entry) {
  try {
    const logDir = path.resolve('./database');
    fs.ensureDirSync(logDir);
    const logFile = path.join(logDir, 'reports.json');
    let logs = [];
    try {
      if (fs.existsSync(logFile)) logs = fs.readJsonSync(logFile) || [];
    } catch (_) {
      logs = [];
    }
    logs.push({ at: new Date().toISOString(), ...entry });
    if (logs.length > 500) logs = logs.slice(-500);
    fs.writeJsonSync(logFile, logs, { spaces: 2 });
  } catch (e) {
    console.error('[report-log]', e.message);
  }
}

async function reportFromSessions(sessions, targetPhoneOrJid, reason, meta = {}) {
  const results = [];
  for (const s of sessions) {
    try {
      const r = await reportViaSocket(s.sock, targetPhoneOrJid, reason);
      results.push({ sessionId: s.sessionId, ...r });
      logReport({
        source: meta.source || 'telegram',
        by: meta.by || null,
        sessionId: s.sessionId,
        target: r.jid,
        reason,
        serverReported: !!r.ok,
        method: r.method || null,
        attempts: r.attempts || []
      });
    } catch (e) {
      results.push({
        sessionId: s.sessionId,
        ok: false,
        jid: targetPhoneOrJid,
        method: null,
        attempts: [{ method: 'fatal', ok: false, detail: errText(e) }],
        errors: [errText(e)]
      });
    }
  }
  return results;
}

module.exports = { reportViaSocket, reportFromSessions, logReport };
