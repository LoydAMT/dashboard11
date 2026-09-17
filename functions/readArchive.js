'use strict';

// Read side of the Firestore archive.
//
// Firestore rules deny every client read on devices/{deviceId}/archive/**,
// and that stays true - this function is the only reader, the same way
// archiveRollups is the only writer. It exists because Firestore rules
// cannot consult the RTDB access list (viewers/operators/admins) that
// actually governs who may see a device, and mirroring that list into
// Firestore would mean two copies to keep in sync forever - a drift bug
// waiting to happen, and a security one at that. So the check happens
// here instead, against the one real list, before anything is returned.
//
// The authorization test below is a deliberate mirror of the RTDB rule on
// devices/{deviceId}/history: authenticated, not anonymous, and a viewer,
// operator, or global admin of that specific device. If that rule ever
// changes, this has to change with it.

const HOUR_MS = 3600000;

// A 7-day chart is 168 hours; this leaves generous headroom for a wider
// range later while still refusing a request that would fan out into
// thousands of document reads on one call.
const MAX_HOURS = 800;

function hourOf(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function validateQuery(q) {
  if (!q || typeof q !== 'object') {
    return { ok: false, reason: 'missing query parameters' };
  }

  const { device, tag } = q;
  const from = Number(q.from);
  const to = Number(q.to);

  if (typeof device !== 'string' || device.length === 0) {
    return { ok: false, reason: 'device must be a non-empty string' };
  }
  if (typeof tag !== 'string' || tag.length === 0) {
    return { ok: false, reason: 'tag must be a non-empty string' };
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { ok: false, reason: 'from and to must be epoch-ms numbers' };
  }
  if (to < from) {
    return { ok: false, reason: 'to must not be earlier than from' };
  }

  const firstHour = hourOf(from);
  const lastHour = hourOf(to);
  const hourCount = (lastHour - firstHour) / HOUR_MS + 1;
  if (hourCount > MAX_HOURS) {
    return { ok: false, reason: `range too wide: ${hourCount} hours, max ${MAX_HOURS}` };
  }

  const hours = [];
  for (let h = firstHour; h <= lastHour; h += HOUR_MS) hours.push(h);

  return { ok: true, device, tag, from, to, hours };
}

// Deliberately NOT the standard `Authorization: Bearer` header, which is
// the obvious choice and does not work here.
//
// Cloud Run inspects `Authorization: Bearer <...>` itself. A Firebase ID
// token is a well-formed JWT, so Cloud Run parses it, tries to validate it
// as a Google IAM identity token for this service, fails (wrong audience),
// and returns its own 401 HTML page before this function is ever invoked.
// Confirmed empirically: a junk non-JWT bearer string is passed through to
// application code untouched, while a genuine Firebase ID token is
// intercepted - the token being *more* valid is what breaks it.
//
// A custom header is not a security downgrade: like Authorization, it is
// never attached automatically cross-origin, it requires an explicit CORS
// allowance, and it stays out of URLs, browser history, and access logs -
// which a query parameter would not.
function idToken(req) {
  const headers = req.headers || {};
  const raw = headers['x-id-token'] || headers['X-Id-Token'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

// verifyToken/hasAccess/getArchiveDocs are injected so tests can exercise
// every branch without a live project - same pattern archiveRollups.js uses.
function createHandler({ verifyToken, hasAccess, getArchiveDocs }) {
  return async function readArchiveHandler(req, res) {
    // The dashboard calls this straight from the browser. A Bearer token is
    // never attached automatically cross-origin the way a cookie would be,
    // so a wildcard origin here does not widen what an attacker can do -
    // they still need a valid ID token for an account with access.
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'X-Id-Token, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    const token = idToken(req);
    if (!token) {
      res.status(401).json({ error: 'missing id token' });
      return;
    }

    let decoded;
    try {
      decoded = await verifyToken(token);
    } catch {
      // Expired or forged - not a fault worth logging, just a refusal.
      res.status(401).json({ error: 'invalid token' });
      return;
    }

    // Mirrors the RTDB rule exactly. Enabling Email/Password sign-in also
    // enables anonymous self-registration through the same public API key,
    // so "signed in" alone is not a permission - see database.rules.json.
    if (!decoded || !decoded.uid || decoded.signInProvider === 'anonymous') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const validation = validateQuery(req.query);
    if (!validation.ok) {
      res.status(400).json({ error: validation.reason });
      return;
    }

    const { device, tag, from, to, hours } = validation;

    let allowed;
    try {
      allowed = await hasAccess(decoded.uid, device);
    } catch (err) {
      console.error('readArchive: access check failed', err);
      res.status(500).json({ error: 'internal error' });
      return;
    }
    if (!allowed) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    let docs;
    try {
      docs = await getArchiveDocs(device, tag, hours);
    } catch (err) {
      console.error('readArchive: firestore read failed', err);
      res.status(500).json({ error: 'internal error' });
      return;
    }

    // Flattened and clipped to the requested window, in the same row shape
    // the dashboard already builds from RTDB rollups ({t,min,avg,max,n}) -
    // so merging the two sources downstream needs no translation layer.
    const rows = [];
    for (const doc of docs || []) {
      for (const s of (doc && doc.samples) || []) {
        if (!s || typeof s.t !== 'number') continue;
        if (s.t < from || s.t > to) continue;
        rows.push({ t: s.t, min: s.min, avg: s.avg, max: s.max, n: s.n });
      }
    }
    rows.sort((a, b) => a.t - b.t);

    res.status(200).json({ device, tag, from, to, rows });
  };
}

module.exports = { createHandler, validateQuery, hourOf, MAX_HOURS };
