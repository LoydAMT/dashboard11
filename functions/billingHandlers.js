'use strict';

// HTTP handlers for billing.
//
// TWO FUNCTIONS, ON PURPOSE. billingApi prepares, lists, edits and previews
// bills and needs no secrets. billingSend is the only thing that holds the
// Resend key and the only thing that can put an email in a tenant's inbox.
// Keeping them apart means everything up to "Send" can be deployed and used
// before an email account exists, and the key is loaded by exactly one
// function rather than every billing request.
//
// Bills live in Firestore under billing/{companyId}/runs/{runId}/bills/{deviceId}.
// Firestore rules deny all client access, and cannot consult the RTDB
// membership list anyway, so every read and write comes through here, where
// membership is checked against the one real list.

const B = require('./billing');
const { buildBillEmail } = require('./billEmail');

// RTDB keys and Firestore ids here are built from request input. Restricting
// them to this alphabet is what stops "mall/../admins" or a slash from
// steering a read or write somewhere else entirely.
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const RUN_ID = /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/;
const STUCK_SENDING_MS = 10 * 60000;

function cors(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'X-Id-Token, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return true; }
  return false;
}

/**
 * The caller, verified. X-Id-Token rather than Authorization: Bearer because
 * Cloud Run intercepts the latter and rejects a Firebase ID token before the
 * function runs - the same reason as readArchive and readAlerts.
 */
async function caller(req, getAuth) {
  const token = req.headers['x-id-token'];
  if (typeof token !== 'string' || !token) return { status: 401, error: 'missing id token' };
  let decoded;
  try { decoded = await getAuth().verifyIdToken(token); }
  catch { return { status: 401, error: 'invalid token' }; }
  if (!decoded.uid || decoded.firebase?.sign_in_provider === 'anonymous') {
    return { status: 403, error: 'forbidden' };
  }
  return { uid: decoded.uid, email: decoded.email || null };
}

/**
 * What this person may do with this company's billing.
 *
 * Reading is for any member. Preparing, editing and sending is for an
 * OPERATOR of the company or a super admin: a bill is money and personal
 * data leaving the building, and "viewer" is the role meant for looking.
 */
async function access(rtdb, companyId, uid) {
  const [m, a] = await Promise.all([
    rtdb.ref(`companyMembers/${companyId}/${uid}`).once('value'),
    rtdb.ref(`admins/${uid}`).once('value'),
  ]);
  const admin = a.val() === true;
  return {
    canRead: admin || m.exists(),
    canEdit: admin || m.val() === 'operator',
  };
}

const runsRef = (fs, companyId) => fs.collection('billing').doc(companyId).collection('runs');

/** Counts and the total, recomputed from the bills so they cannot drift. */
function summarize(bills) {
  const s = { tenants: bills.length, included: 0, sent: 0, failed: 0, blocked: 0, total: 0 };
  for (const b of bills) {
    if (b.status === 'sent') s.sent += 1;
    if (b.status === 'failed') s.failed += 1;
    if (b.included) {
      s.included += 1;
      s.total += Math.round((b.total || 0) * 100);
      if (b.status !== 'sent' && B.sendBlocker(b)) s.blocked += 1;
    }
  }
  s.total /= 100;
  s.status = s.sent === 0 ? 'draft' : s.sent >= s.included ? 'sent' : 'partial';
  return s;
}

async function loadRun(fs, companyId, runId) {
  const ref = runsRef(fs, companyId).doc(runId);
  const [runSnap, billsSnap] = await Promise.all([ref.get(), ref.collection('bills').get()]);
  if (!runSnap.exists) return null;
  return { ref, run: { id: runId, ...runSnap.data() }, bills: billsSnap.docs.map((d) => d.data()) };
}

/** Which tag on this device is the kWh meter. */
async function kwhKeyOf(rtdb, deviceId) {
  const tags = (await rtdb.ref(`devices/${deviceId}/tags`).once('value')).val() || {};
  return Object.keys(tags).find((k) => /kwh/i.test(k)) || 'kWh';
}

/**
 * Raw kWh readings around a period. Ordered by key: the keys are 13-digit
 * millisecond timestamps, all the same length, so their string order is
 * their time order. Two days of margin either side lets a reading taken
 * late - a box that was offline at 22:00 - still be found.
 */
async function readingsFor(rtdb, deviceId, startTs, endTs) {
  const key = await kwhKeyOf(rtdb, deviceId);
  const snap = await rtdb.ref(`devices/${deviceId}/history/${key}/raw`)
    .orderByKey()
    .startAt(String(startTs - 2 * B.DAY_MS))
    .endAt(String(endTs + B.DAY_MS))
    .once('value');
  return Object.entries(snap.val() || {}).map(([ts, value]) => ({ ts: Number(ts), value: Number(value) }));
}

function createBillingApi({ getDatabase, getFirestore, getAuth, FieldValue }) {
  return async (req, res) => {
    if (cors(req, res)) return;
    res.set('Cache-Control', 'no-store');
    const who = await caller(req, getAuth);
    if (who.error) { res.status(who.status).json({ error: who.error }); return; }

    const input = req.method === 'POST' ? (req.body || {}) : req.query;
    const action = String(input.action || '');
    const companyId = String(input.company || '');
    if (!ID.test(companyId)) { res.status(400).json({ error: 'company required' }); return; }

    const rtdb = getDatabase();
    const fs = getFirestore();
    const acl = await access(rtdb, companyId, who.uid);
    if (!acl.canRead) { res.status(403).json({ error: 'forbidden' }); return; }

    const needEdit = ['prepare', 'update', 'discard'].includes(action);
    if (needEdit && !acl.canEdit) {
      res.status(403).json({ error: 'Only an operator of this company can change bills' }); return;
    }
    if (needEdit && req.method !== 'POST') { res.status(405).json({ error: 'POST required' }); return; }

    try {
      if (action === 'runs') {
        const snap = await runsRef(fs, companyId).orderBy('updatedAt', 'desc').limit(60).get();
        res.json({ canEdit: acl.canEdit, runs: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
        return;
      }

      const runId = String(input.run || '');

      if (action === 'run') {
        if (!RUN_ID.test(runId)) { res.status(400).json({ error: 'run required' }); return; }
        const r = await loadRun(fs, companyId, runId);
        if (!r) { res.status(404).json({ error: 'no such run' }); return; }
        res.json({ canEdit: acl.canEdit, run: r.run, bills: r.bills });
        return;
      }

      if (action === 'prepare') {
        const period = B.periodBoundaries(input.from, input.to);
        if (period.error) { res.status(400).json({ error: period.error }); return; }

        const [companySnap, billingSnap] = await Promise.all([
          rtdb.ref(`companies/${companyId}`).once('value'),
          rtdb.ref(`companyBilling/${companyId}`).once('value'),
        ]);
        const company = companySnap.val() || {};
        const billingCfg = billingSnap.val() || {};
        const cfg = B.readSettings(billingCfg);
        if (cfg.error) { res.status(400).json({ error: cfg.error }); return; }

        const deviceIds = Object.keys(company.devices || {}).filter((d) => company.devices[d] === true);
        if (deviceIds.length === 0) { res.status(400).json({ error: 'This company has no tenants' }); return; }

        const id = `${input.from}_${input.to}`;
        const ref = runsRef(fs, companyId).doc(id);
        const existing = {};
        const prevRun = await ref.get();
        for (const d of (await ref.collection('bills').get()).docs) existing[d.id] = d.data();

        const contacts = billingCfg.tenants || {};
        const bills = await Promise.all(deviceIds.map(async (deviceId) => {
          const prev = existing[deviceId];
          // A sent bill is a record of what a tenant was told. Refreshing
          // the run leaves it exactly as it went out.
          if (prev && (prev.status === 'sent' || prev.status === 'sending')) return prev;

          const [readings, nameSnap] = await Promise.all([
            readingsFor(rtdb, deviceId, period.startTs, period.endTs),
            rtdb.ref(`naming/${deviceId}`).once('value'),
          ]);
          const contact = contacts[deviceId] || {};
          const bill = B.draftBill({
            deviceId,
            tenantName: contact.billingName || nameSnap.val() || deviceId,
            emails: contact.emails || '',
            readings,
            period,
            settings: cfg.settings,
            // A refresh re-reads meters, rates and contacts, but keeps the
            // decisions a person already made on this draft.
            keep: prev ? { included: prev.included, adjustKwh: prev.adjustKwh, adjustNote: prev.adjustNote } : {},
          });
          return {
            ...bill,
            // A refresh is how a failed bill gets fixed (a corrected address,
            // say), so it comes back as a draft and the old error is dropped.
            // The attempt count carries over: the next send must use a NEW
            // idempotency key, because the failed one produced no email.
            status: 'draft',
            attempts: prev?.attempts || 0,
            lastError: null,
          };
        }));

        const batch = fs.batch();
        for (const b of bills) {
          if (b.status !== 'sent' && b.status !== 'sending') batch.set(ref.collection('bills').doc(b.deviceId), b);
        }
        // A tenant who has left the company since the draft was made should
        // not be billed for this run. Unsent drafts for them are removed;
        // sent ones are kept, because they happened.
        for (const [devId, b] of Object.entries(existing)) {
          if (!deviceIds.includes(devId) && b.status !== 'sent') batch.delete(ref.collection('bills').doc(devId));
        }
        const summary = summarize(bills);
        batch.set(ref, {
          periodFrom: input.from,
          periodTo: input.to,
          startTs: period.startTs,
          endTs: period.endTs,
          days: period.days,
          companyName: company.name || companyId,
          settings: cfg.settings,
          summary,
          createdAt: prevRun.exists ? prevRun.get('createdAt') : FieldValue.serverTimestamp(),
          createdBy: prevRun.exists ? prevRun.get('createdBy') : (who.email || who.uid),
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: who.email || who.uid,
        }, { merge: true });
        await batch.commit();

        const r = await loadRun(fs, companyId, id);
        res.json({ canEdit: acl.canEdit, run: r.run, bills: r.bills });
        return;
      }

      if (!RUN_ID.test(runId)) { res.status(400).json({ error: 'run required' }); return; }

      if (action === 'update') {
        const deviceId = String(input.device || '');
        if (!ID.test(deviceId)) { res.status(400).json({ error: 'device required' }); return; }
        const r = await loadRun(fs, companyId, runId);
        if (!r) { res.status(404).json({ error: 'no such run' }); return; }
        const bill = r.bills.find((b) => b.deviceId === deviceId);
        if (!bill) { res.status(404).json({ error: 'no such bill' }); return; }
        if (bill.status === 'sent' || bill.status === 'sending') {
          res.status(409).json({ error: 'This bill has already gone out and cannot be changed' }); return;
        }

        const next = { ...bill };
        if (typeof input.included === 'boolean') next.included = input.included;
        if ('adjustKwh' in input) {
          const v = input.adjustKwh;
          if (v === null || v === '') {
            next.adjustKwh = null;
            next.adjustNote = null;
          } else {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0 || n > 10_000_000) {
              res.status(400).json({ error: 'Enter a kWh figure of zero or more' }); return;
            }
            const note = String(input.adjustNote || '').trim().slice(0, 300);
            // An adjustment changes what a tenant pays. It has to say why,
            // on the bill, where the tenant can read it.
            if (!note) { res.status(400).json({ error: 'Say why the figure was adjusted - the tenant sees this' }); return; }
            next.adjustKwh = Math.round(n * 1000) / 1000;
            next.adjustNote = note;
          }
          next.kwh = Number.isFinite(next.adjustKwh) ? next.adjustKwh : next.measuredKwh;
          // Priced at the rate FROZEN on this draft, not today's setting, so
          // an edit cannot quietly reprice the rest of the bill.
          Object.assign(next, B.amounts({
            kwh: next.kwh, ratePerKwh: next.rate, vatPct: next.vatPct, fixedCharge: next.fixedCharge,
          }));
        }

        const bills = r.bills.map((b) => (b.deviceId === deviceId ? next : b));
        const batch = fs.batch();
        batch.set(r.ref.collection('bills').doc(deviceId), next);
        batch.set(r.ref, {
          summary: summarize(bills),
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: who.email || who.uid,
        }, { merge: true });
        await batch.commit();
        res.json({ bill: next, summary: summarize(bills) });
        return;
      }

      if (action === 'discard') {
        const r = await loadRun(fs, companyId, runId);
        if (!r) { res.status(404).json({ error: 'no such run' }); return; }
        // Sent bills are records of what tenants were told and charged.
        // A run holding any is kept, whole.
        if (r.bills.some((b) => b.status === 'sent' || b.status === 'sending')) {
          res.status(409).json({ error: 'This run has bills that were already sent, so it is kept as a record' });
          return;
        }
        const batch = fs.batch();
        for (const b of r.bills) batch.delete(r.ref.collection('bills').doc(b.deviceId));
        batch.delete(r.ref);
        await batch.commit();
        res.json({ ok: true });
        return;
      }

      if (action === 'preview') {
        const deviceId = String(input.device || '');
        if (!ID.test(deviceId)) { res.status(400).json({ error: 'device required' }); return; }
        const r = await loadRun(fs, companyId, runId);
        const bill = r && r.bills.find((b) => b.deviceId === deviceId);
        if (!bill) { res.status(404).json({ error: 'no such bill' }); return; }
        const company = { name: r.run.companyName, ...r.run.settings };
        const mail = buildBillEmail({ bill, run: r.run, company });
        res.json({
          ...mail,
          to: bill.to,
          replyTo: company.replyTo || null,
          blocker: B.sendBlocker(bill),
        });
        return;
      }

      res.status(400).json({ error: 'unknown action' });
    } catch (err) {
      console.error(`billingApi ${action} ${companyId} failed`, err);
      res.status(500).json({ error: 'billing request failed' });
    }
  };
}

/**
 * Sends a run's bills through Resend.
 *
 * NOTHING HERE MAY SEND A BILL TWICE. Each bill is moved to 'sending' in a
 * transaction first, so two clicks - or two browser tabs - cannot both
 * claim it. The Resend request carries an idempotency key built from the
 * bill and its attempt number, so if this function dies after Resend
 * accepted the email but before the bill was marked sent, the retry is
 * recognised by Resend as the same email and not delivered again. The
 * attempt number only advances when Resend definitely REFUSED an email,
 * which is the one case where sending again is correct.
 */
function createBillingSend({ getDatabase, getFirestore, getAuth, FieldValue, apiKey, fromAddress, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  return async (req, res) => {
    if (cors(req, res)) return;
    res.set('Cache-Control', 'no-store');
    const who = await caller(req, getAuth);
    if (who.error) { res.status(who.status).json({ error: who.error }); return; }

    const input = req.method === 'POST' ? (req.body || {}) : req.query;
    // Lets the page know sending is actually available before offering the
    // button - this function is deployed separately, once a key exists.
    if (input.action === 'status') {
      res.json({ ok: Boolean(apiKey()), from: fromAddress });
      return;
    }

    if (req.method !== 'POST' || input.action !== 'send') {
      res.status(400).json({ error: 'POST {action: "send"} required' }); return;
    }
    const companyId = String(input.company || '');
    const runId = String(input.run || '');
    if (!ID.test(companyId) || !RUN_ID.test(runId)) {
      res.status(400).json({ error: 'company and run required' }); return;
    }
    const only = Array.isArray(input.devices) ? input.devices.filter((d) => ID.test(d)) : null;

    const rtdb = getDatabase();
    const fs = getFirestore();
    const acl = await access(rtdb, companyId, who.uid);
    if (!acl.canEdit) { res.status(403).json({ error: 'Only an operator of this company can send bills' }); return; }

    const key = apiKey();
    if (!key) { res.status(503).json({ error: 'Email sending is not configured' }); return; }

    const r = await loadRun(fs, companyId, runId);
    if (!r) { res.status(404).json({ error: 'no such run' }); return; }
    const company = { name: r.run.companyName, ...r.run.settings };
    const displayName = B.cleanName(company.senderName || company.name) || 'Billing';
    const from = `"${displayName}" <${fromAddress}>`;

    const results = [];
    for (const snapBill of r.bills) {
      if (only && !only.includes(snapBill.deviceId)) continue;
      const billRef = r.ref.collection('bills').doc(snapBill.deviceId);

      // Claim it. Re-read inside the transaction: the copy loaded above may
      // already be stale if someone else pressed Send a moment ago.
      let claimed = null;
      let skip = null;
      await fs.runTransaction(async (tx) => {
        const cur = (await tx.get(billRef)).data();
        const blocker = B.sendBlocker(cur);
        if (blocker) { skip = blocker; return; }
        if (cur.status === 'sending') {
          const since = cur.sendingAt?.toMillis ? cur.sendingAt.toMillis() : 0;
          if (Date.now() - since < STUCK_SENDING_MS) { skip = 'already being sent'; return; }
          // Stuck from a crash. Retried with the SAME attempt number, so the
          // idempotency key matches and Resend will not deliver it twice.
        }
        tx.update(billRef, { status: 'sending', sendingAt: FieldValue.serverTimestamp(), sendingBy: who.email || who.uid });
        claimed = cur;
      });
      if (!claimed) { results.push({ deviceId: snapBill.deviceId, skipped: skip }); continue; }

      const mail = buildBillEmail({ bill: claimed, run: r.run, company });
      const attempt = claimed.attempts || 0;
      try {
        const resp = await doFetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `bill/${companyId}/${runId}/${claimed.deviceId}/${attempt}`,
          },
          body: JSON.stringify({
            from,
            to: claimed.to,
            // The mall gets a copy of every bill it issues, and a tenant's
            // reply goes to the mall - not to us.
            ...(company.replyTo ? { reply_to: company.replyTo, cc: [company.replyTo] } : {}),
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
          }),
        });
        const body = await resp.json().catch(() => ({}));
        if (resp.ok && body.id) {
          await billRef.update({
            status: 'sent', sentAt: FieldValue.serverTimestamp(), sentBy: who.email || who.uid,
            sentTo: claimed.to, cc: company.replyTo ? [company.replyTo] : [], messageId: body.id, lastError: null,
          });
          results.push({ deviceId: claimed.deviceId, sent: true });
        } else {
          // Refused. The next attempt gets a new idempotency key, because
          // this one did not result in an email and should not be replayed.
          const msg = String(body.message || body.name || `HTTP ${resp.status}`).slice(0, 300);
          await billRef.update({ status: 'failed', attempts: attempt + 1, lastError: msg });
          results.push({ deviceId: claimed.deviceId, error: msg });
        }
      } catch (err) {
        // A network failure: whether Resend received it is unknown. Left in
        // 'sending' with the SAME attempt number - a retry after the stuck
        // window reuses the key, so it either completes or is deduplicated.
        results.push({ deviceId: claimed.deviceId, error: 'network error - retry in 10 minutes' });
        console.error(`billingSend ${companyId}/${runId}/${claimed.deviceId}`, err);
      }

      // Resend's default rate limit is two requests a second.
      await new Promise((ok) => setTimeout(ok, 600));
    }

    const after = await loadRun(fs, companyId, runId);
    await after.ref.set({ summary: summarize(after.bills), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    res.json({ results, summary: summarize(after.bills) });
  };
}

module.exports = { createBillingApi, createBillingSend, summarize, ID, RUN_ID };
