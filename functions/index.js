'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onValueWritten } = require('firebase-functions/v2/database');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');

const { createHandler, tupleToSampleMap } = require('./archiveRollups');
const { createHandler: createReadHandler } = require('./readArchive');
const { createSweep, hourOf, HOUR_MS } = require('./archiveSweep');
const { computeProjection, toUpdates } = require('./projectCompanyAccess');
const { evaluate: evaluateAlerts, alertId } = require('./alertEngine');
const { buildSnapshot, phDateKey } = require('./kwhSnapshot');
const AF = require('./archiveFormat');
const { listDevices, overviewCompanies } = require('./deviceRegistry');
const { tenantRow, rollUp } = require('./mallOverview');

if (getApps().length === 0) {
  initializeApp();
}

const ARCHIVE_RELAY_KEY = defineSecret('ARCHIVE_RELAY_KEY');

// Receives minute-rollup packages from the edge device (Wecon RH-W / Lua)
// and archives them into Firestore at devices/{device}/archive/{tag}_{hour}.
// The device has no OAuth token, so this function is the only writer -
// Firestore rules deny all direct client access to that path.
exports.archiveRollups = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [ARCHIVE_RELAY_KEY],
  },
  createHandler({
    expectedKey: () => ARCHIVE_RELAY_KEY.value(),
    db: () => getFirestore(),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  })
);

// Read side. The dashboard calls this for history older than whatever is
// still in RTDB; see readArchive.js for why the authorization check lives
// here rather than in Firestore rules.
exports.readArchive = onRequest(
  { region: 'asia-southeast1' },
  createReadHandler({
    verifyToken: async (idToken) => {
      const decoded = await getAuth().verifyIdToken(idToken);
      return {
        uid: decoded.uid,
        signInProvider: decoded.firebase && decoded.firebase.sign_in_provider,
      };
    },

    // Deliberately the same three checks, in the same order, as the
    // .read rule on devices/{deviceId}/history in database.rules.json.
    hasAccess: async (uid, device) => {
      const rtdb = getDatabase();
      const [viewer, operator, admin] = await Promise.all([
        rtdb.ref(`devices/${device}/viewers/${uid}`).once('value'),
        rtdb.ref(`devices/${device}/operators/${uid}`).once('value'),
        rtdb.ref(`admins/${uid}`).once('value'),
      ]);
      return viewer.val() === true || operator.val() === true || admin.val() === true;
    },

    // Fetched by deterministic document id ({tag}_{hour}) rather than a
    // where() query: same number of document reads, but no composite index
    // to create and keep deployed, and a missing hour simply comes back
    // non-existent instead of needing its own handling.
    // Day documents, not hourly ones. `hours` still arrives as a list of
    // hours from validateQuery, so it is collapsed to the distinct days it
    // touches - 168 hours becomes 7 reads instead of 168.
    //
    // Returned in the v1 { samples: [...] } shape because that is what the
    // handler already clips and flattens; unpackDay reads either format, so
    // a document written before the change still works.
    getArchiveDocs: async (device, tag, hours) => {
      const fs = getFirestore();
      const col = fs.collection('devices').doc(device).collection('archive');
      const ids = [...new Set(hours.map((h) => AF.docIdFor(tag, AF.dayOf(h))))];
      const refs = ids.map((id) => col.doc(id));
      const snaps = await fs.getAll(...refs);
      return snaps
        .filter((s) => s.exists)
        .map((s) => ({ samples: AF.unpackDay(s.data()) }));
    },
  })
);

// Devices that must be swept even if no company lists them yet.
//
// NOT the sweep list - that now comes from companies/ (see deviceRegistry).
// These are seeds for one real situation: a box commissioned and publishing
// before anyone has set up its company. Dropping it from the sweeps during
// that window means it is silently never archived and never alerted on, on
// a site nobody is watching precisely because it looks fine.
//
// /devices is still never enumerated directly: the Admin SDK has no shallow
// read, so listing it would mean pulling every device's entire subtree -
// the single most expensive thing possible on this database, to learn some
// names. companies/ is small and is already the source of truth for which
// devices exist.
const SEED_DEVICES = [
  'RHW01',
  // wecon2 and wecon3 are SHARED boxes: the box id itself is also the first
  // tenant, so it keeps publishing readings rather than sitting online with
  // nothing to show.
  'wecon2', 'wecon2-c2', 'wecon2-c3',
  'wecon3', 'wecon3-c2', 'wecon3-c3',
];

/**
 * The device list plus the company map, read once per sweep run.
 *
 * companies/ is one small node, so this is a single round trip that
 * replaces a hand-maintained array. A sweep that cannot read it falls back
 * to the seeds rather than sweeping nothing: doing less work is survivable,
 * doing none silently is not.
 */
async function loadSweepContext() {
  let companies = {};
  try {
    companies = (await getDatabase().ref('companies').once('value')).val() || {};
  } catch (err) {
    console.error('loadSweepContext: companies unreadable, falling back to seeds', err);
  }
  return {
    companies,
    devices: listDevices({ companies, seed: SEED_DEVICES }),
  };
}

const rollupRef = (device, tag) => getDatabase().ref(`devices/${device}/history/${tag}`);

// Scheduled archive + prune. See archiveSweep.js for why this exists on the
// server at all rather than being left to the devices.
exports.archiveSweep = onSchedule(
  {
    region: 'asia-southeast1',
    schedule: 'every 10 minutes',
    timeZone: 'Etc/UTC',
    // Bounded work per run, but each hour is several RTDB round trips, so
    // the default 60s is not enough headroom.
    timeoutSeconds: 540,
    memory: '512MiB',
    // One sweep at a time. Two overlapping runs would both read the same
    // watermark and redo the same hours.
    maxInstances: 1,
  },
  async () => {
    const { devices: sweepDevices } = await loadSweepContext();
    const sweep = createSweep({
      devices: sweepDevices,
      log: (msg) => console.log(`archiveSweep: ${msg}`),

      // The tags/ metadata node, not a listing of history/ - it is small,
      // already published by every device, and naming a tag that has no
      // rollups (kWh, Frequency) costs one empty read and is skipped.
      readTagKeys: async (device) => {
        const snap = await getDatabase().ref(`devices/${device}/tags`).once('value');
        return Object.keys(snap.val() || {});
      },

      // First run only: where does this device's history actually start?
      // Integer-like keys sort before any other string in RTDB, so the
      // first key is the oldest minute and never the sibling `raw` node.
      readOldestRollupHour: async (device, tags) => {
        let oldest = null;
        for (const tag of tags) {
          const snap = await rollupRef(device, tag).orderByKey().limitToFirst(1).once('value');
          for (const key of Object.keys(snap.val() || {})) {
            const t = Number(key);
            if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
          }
        }
        return oldest === null ? null : hourOf(oldest);
      },

      readHourRollups: async (device, tag, hourStart) => {
        const snap = await rollupRef(device, tag)
          .orderByKey()
          .startAt(String(hourStart))
          .endAt(String(hourStart + HOUR_MS - 1))
          .once('value');
        return snap.val() || {};
      },

      // Same collection, same deterministic {tag}_{hour} document id and
      // same field shape as archiveRollups writes, so a device archiving
      // the same hour overwrites this with identical content instead of
      // creating a duplicate.
      // One document per tag per DAY (see archiveFormat.js). An hour is
      // merged INTO its day document rather than replacing it, because the
      // sweep still works an hour at a time - so the other 23 hours already
      // stored must survive this write.
      writeArchiveHour: async (device, hour, perTag) => {
        const fs = getFirestore();
        const day = AF.dayOf(hour);
        const receivedAt = FieldValue.serverTimestamp();
        let count = 0;

        for (const [tag, tuples] of Object.entries(perTag)) {
          const ref = fs
            .collection('devices').doc(device)
            .collection('archive').doc(AF.docIdFor(tag, day));

          // Read-merge-write, inside a transaction. Two hours of the same
          // day can be archived in one run, and a plain set() would have
          // the second overwrite the first.
          await fs.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const existing = snap.exists ? AF.unpackDay(snap.data()) : [];
            const incoming = tuples.map(tupleToSampleMap);

            // Incoming wins on a collision: it was just read from RTDB and
            // is therefore at least as current as whatever is stored.
            const byT = new Map(existing.map((r) => [r.t, r]));
            for (const r of incoming) byT.set(r.t, r);

            const packed = AF.packDay({
              device, tag, day, rows: [...byT.values()],
            });
            if (packed) tx.set(ref, { ...packed, receivedAt });
          });
          count += 1;
        }
        return count;
      },

      // Re-reads the hour's keys rather than trusting the archive pass,
      // because the two run off different watermarks and can be many hours
      // apart. Deleting by explicit key also means the sibling `raw`
      // subtree can never be caught up in it.
      deleteHourRollups: async (device, tags, hourStart) => {
        let removed = 0;
        for (const tag of tags) {
          const ref = rollupRef(device, tag);
          const snap = await ref
            .orderByKey()
            .startAt(String(hourStart))
            .endAt(String(hourStart + HOUR_MS - 1))
            .once('value');
          const nulls = {};
          for (const key of Object.keys(snap.val() || {})) {
            if (!Number.isFinite(Number(key))) continue;
            nulls[key] = null;
            removed += 1;
          }
          if (Object.keys(nulls).length > 0) await ref.update(nulls);
        }
        return removed;
      },

      // Watermarks live in Firestore, not RTDB: RTDB reads are the metered
      // resource here, and this is state the devices must never see.
      readState: async (device) => {
        const snap = await getFirestore().collection('sweepState').doc(device).get();
        return snap.exists ? snap.data() : null;
      },
      writeState: async (device, state) => {
        await getFirestore().collection('sweepState').doc(device).set(
          { ...state, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      },
    });

    const results = await sweep();
    for (const r of results) {
      console.log(`archiveSweep: ${JSON.stringify(r)}`);
    }
  }
);

// Keeps the flat access nodes in step with companies/.
//
// Fires on any write under companies/ and recomputes the WHOLE projection -
// not a delta. See projectCompanyAccess.js for why a delta is the wrong
// shape for something that has to revoke correctly.
async function recomputeCompanyAccess() {
  {
    const rtdb = getDatabase();

    const [companiesSnap, membersSnap, adminsSnap, accessSnap] = await Promise.all([
      rtdb.ref('companies').once('value'),
      rtdb.ref('companyMembers').once('value'),
      rtdb.ref('admins').once('value'),
      rtdb.ref('access').once('value'),
    ]);

    const companies = companiesSnap.val() || {};
    const membersByCompany = membersSnap.val() || {};
    const adminUids = Object.keys(adminsSnap.val() || {});
    const accessNow = accessSnap.val() || {};

    // Membership lives in its own node (see database.rules.json for why),
    // so stitch it back on before projecting. computeProjection stays a
    // pure function over one shape and does not need to know about the
    // split.
    for (const [companyId, company] of Object.entries(companies)) {
      if (company && typeof company === 'object') {
        company.members = membersByCompany[companyId] || {};
      }
    }

    // Safety valve. An empty companies/ node would otherwise project to
    // "nobody has access to anything" and revoke the entire fleet in one
    // write. That is never a legitimate state to act on - if companies/ is
    // genuinely meant to be emptied, it should be done deliberately, not as
    // a side effect of a bad edit or a partially-applied migration.
    if (Object.keys(companies).length === 0) {
      console.warn('projectCompanyAccess: companies/ is empty - refusing to revoke everything');
      return;
    }

    // Devices to consider: those named by a company, plus any a uid is
    // currently indexed against. Without the second set, a device removed
    // from every company would keep its old grant list forever.
    const knownDevices = new Set();
    for (const c of Object.values(companies)) {
      for (const d of Object.keys((c && c.devices) || {})) knownDevices.add(d);
    }
    for (const devs of Object.values(accessNow)) {
      for (const d of Object.keys(devs || {})) knownDevices.add(d);
    }

    const existingGrants = {};
    await Promise.all([...knownDevices].map(async (d) => {
      const [v, o] = await Promise.all([
        rtdb.ref(`devices/${d}/viewers`).once('value'),
        rtdb.ref(`devices/${d}/operators`).once('value'),
      ]);
      existingGrants[d] = { viewers: v.val() || {}, operators: o.val() || {} };
    }));

    const projection = computeProjection({
      companies,
      adminUids,
      existing: { deviceGrants: existingGrants, access: accessNow },
    });
    // Ensure every previously-known device is represented so it can be cleared.
    for (const d of knownDevices) {
      projection.deviceGrants[d] = projection.deviceGrants[d] || { viewers: {}, operators: {} };
    }

    const updates = toUpdates(projection, { knownUids: Object.keys(accessNow) });
    await rtdb.ref().update(updates);

    console.log(`projectCompanyAccess: ${Object.keys(companies).length} companies -> ` +
      `${knownDevices.size} devices, ${Object.keys(projection.access).length} accounts`);
  }
}

// Two triggers, one body. A company's device list and its member list live
// in separate nodes (see database.rules.json), and a change to either must
// re-project - adding a member is exactly as much an access change as
// adding a device.
const TRIGGER_OPTS = {
  instance: 'testononlinedb-default-rtdb',
  region: 'asia-southeast1',
  maxInstances: 1,   // serialise: two concurrent recomputes would race
};

exports.projectCompanyAccess = onValueWritten(
  { ...TRIGGER_OPTS, ref: '/companies/{companyId}' },
  recomputeCompanyAccess,
);

exports.projectCompanyMembers = onValueWritten(
  { ...TRIGGER_OPTS, ref: '/companyMembers/{companyId}' },
  recomputeCompanyAccess,
);

// ---------------------------------------------------------------------------
//  Alerts
// ---------------------------------------------------------------------------

// Limits live in RTDB at alertRules/{device}/{tagKey} = { hi, lo }, NOT in
// devices/{device}/tags. The device rewrites its own tags/ node on every
// push_meta(), which would erase anything stored alongside it. Rules are
// server-owned; the box never sees them.
//
// A device with no rules still produces offline/online alerts - "the box
// stopped reporting" needs no configuration and is the alert that matters
// most when nobody is watching.
exports.alertSweep = onSchedule(
  {
    region: 'asia-southeast1',
    schedule: 'every 2 minutes',
    timeZone: 'Etc/UTC',
    timeoutSeconds: 300,
    maxInstances: 1,   // state is read-modify-write; two runs would race
  },
  async () => {
    const rtdb = getDatabase();
    const fs = getFirestore();
    const now = Date.now();
    // Look back further than the schedule interval so a late rollup, or a
    // skipped run, is still picked up. The watermark makes the overlap a
    // no-op rather than a duplicate.
    const since = now - 15 * 60000;

    const { companies, devices: sweepDevices } = await loadSweepContext();
    // Filled as each device is evaluated, then projected into the landlord
    // view below. Built from work this sweep is doing anyway - the whole
    // reason the overview lives here rather than in a second sweep of its
    // own.
    const rows = {};

    for (const device of sweepDevices) {
      try {
        const [rulesSnap, tagsSnap, statusSnap, stateDoc, latestSnap, nameSnap] =
          await Promise.all([
            rtdb.ref(`alertRules/${device}`).once('value'),
            rtdb.ref(`devices/${device}/tags`).once('value'),
            rtdb.ref(`devices/${device}/status`).once('value'),
            fs.collection('alertState').doc(device).get(),
            // The only two reads added for the overview. Everything else on
            // this line was already being fetched to evaluate alerts.
            rtdb.ref(`devices/${device}/latest`).once('value'),
            rtdb.ref(`naming/${device}`).once('value'),
          ]);

        const rules = rulesSnap.val() || {};
        const tagsMeta = tagsSnap.val() || {};
        const status = statusSnap.val() || {};
        const prevState = stateDoc.exists ? (stateDoc.data() || {}) : {};

        const tagNames = {};
        for (const [k, m] of Object.entries(tagsMeta)) tagNames[k] = (m && m.name) || k;

        // EVERY tag with history, not only those with a configured limit.
        // Spike detection needs a baseline for each tag, and limits are the
        // exception rather than the rule here - reading only ruled tags left
        // the log empty on a healthy site, which is what was observed after
        // the first deploy. A tag with no minute rollups (an accumulator, or
        // a live-only tag) simply returns nothing.
        const historyTags = Object.entries(tagsMeta)
          .filter(([, m]) => !m || m.history !== false)
          .map(([k]) => k);
        const tagsToRead = [...new Set([...historyTags, ...Object.keys(rules)])];

        const byMinute = new Map();
        for (const tagKey of tagsToRead) {
          const snap = await rtdb.ref(`devices/${device}/history/${tagKey}`)
            .orderByKey().startAt(String(since)).endAt('9999999999999').once('value');
          for (const [minute, r] of Object.entries(snap.val() || {})) {
            const t = Number(minute);
            if (!Number.isFinite(t) || !r || typeof r !== 'object') continue;
            if (!byMinute.has(t)) byMinute.set(t, { minute: t, byTag: {} });
            byMinute.get(t).byTag[tagKey] = r;
          }
        }
        const windows = [...byMinute.values()].sort((a, b) => a.minute - b.minute);

        const { events, state } = evaluateAlerts({
          device, windows, rules, tagNames, prevState, status, now,
        });

        if (events.length > 0) {
          const batch = fs.batch();
          for (const ev of events) {
            const ref = fs.collection('devices').doc(device)
              .collection('alerts').doc(alertId(ev));
            // Deterministic id + set(): a re-run over the same window
            // overwrites with identical content instead of appending a
            // second copy of the same event.
            batch.set(ref, { ...ev, recordedAt: FieldValue.serverTimestamp() });
          }
          await batch.commit();
        }

        // State is written AFTER the alerts, so a crash in between re-runs
        // the same window and re-writes the same deterministic ids rather
        // than losing the events entirely.
        await fs.collection('alertState').doc(device).set(state, { merge: true });

        // Landlord view. Uses the state the engine just computed, so the
        // overview and the alert log can never disagree about whether a
        // tenant is in alarm.
        rows[device] = tenantRow({
          deviceId: device,
          name: nameSnap.val(),
          latest: latestSnap.val(),
          status,
          tagState: state.tags || {},
          offline: state.offline,
          now,
        });

        if (events.length > 0) {
          console.log(`alertSweep: ${device} -> ${events.length} event(s): ` +
            events.map((e) => e.kind).join(', '));
        }
      } catch (err) {
        // One device failing must not stop the rest.
        console.error(`alertSweep: ${device} failed`, err);
      }
    }

    // One node per multi-device company. Written as a multi-path update
    // touching only the fields this sweep owns, so the daily kWh figures
    // that kwhDailySnapshot writes into the same node are left alone - a
    // full set() here would wipe them every two minutes.
    try {
      const updates = {};
      for (const companyId of overviewCompanies(companies)) {
        const deviceIds = Object.keys(companies[companyId].devices || {});
        const mine = {};
        for (const id of deviceIds) {
          const row = rows[id];
          if (!row) continue;   // never evaluated this run; leave what is there
          mine[id] = row;
          const base = `mallOverview/${companyId}/tenants/${id}`;
          updates[`${base}/name`] = row.name;
          updates[`${base}/alarm`] = row.alarm;
          updates[`${base}/online`] = row.online;
          updates[`${base}/lastSeen`] = row.lastSeen;
          // Explicit null, not {}: RTDB stores no empty objects, so this
          // says "clear the readings" unambiguously. It matters - a tenant
          // whose latest/ became unreadable must stop showing the numbers
          // it had an hour ago, not keep them because we skipped the write.
          updates[`${base}/values`] =
            Object.keys(row.values).length > 0 ? row.values : null;
        }
        const totals = rollUp(mine);
        // The company's real size, NOT the number evaluated this run. A
        // device that threw above keeps its previous row in the node, so
        // counting only evaluated ones would make the headline tenant count
        // flicker on a transient read failure.
        updates[`mallOverview/${companyId}/totals/tenants`] = deviceIds.length;
        updates[`mallOverview/${companyId}/totals/inAlarm`] = totals.inAlarm;
        updates[`mallOverview/${companyId}/totals/offline`] = totals.offline;
        updates[`mallOverview/${companyId}/updatedAt`] = now;
      }
      if (Object.keys(updates).length > 0) {
        await rtdb.ref().update(updates);
        console.log(`alertSweep: overview updated for ` +
          `${overviewCompanies(companies).length} company(ies)`);
      }
    } catch (err) {
      // The overview is a convenience view. Failing to write it must never
      // fail the alert sweep, which is the part that matters.
      console.error('alertSweep: overview projection failed', err);
    }
  }
);

// Read side for the alert history. Same authorization as readArchive - the
// alert log says as much about a site as its telemetry does, so it gets the
// same per-device check, not a weaker one.
exports.readAlerts = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'X-Id-Token, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }

    // X-Id-Token, not Authorization: Bearer - Cloud Run intercepts the
    // latter and rejects a Firebase ID token before this runs. See the note
    // in readArchive.js.
    const token = req.headers['x-id-token'];
    if (typeof token !== 'string' || !token) { res.status(401).json({ error: 'missing id token' }); return; }

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(token);
    } catch { res.status(401).json({ error: 'invalid token' }); return; }
    if (!decoded.uid || (decoded.firebase && decoded.firebase.sign_in_provider === 'anonymous')) {
      res.status(403).json({ error: 'forbidden' }); return;
    }

    const device = req.query.device;
    if (typeof device !== 'string' || !device) { res.status(400).json({ error: 'device required' }); return; }

    const rtdb = getDatabase();
    const [viewer, operator, admin] = await Promise.all([
      rtdb.ref(`devices/${device}/viewers/${decoded.uid}`).once('value'),
      rtdb.ref(`devices/${device}/operators/${decoded.uid}`).once('value'),
      rtdb.ref(`admins/${decoded.uid}`).once('value'),
    ]);
    if (!(viewer.val() === true || operator.val() === true || admin.val() === true)) {
      res.status(403).json({ error: 'forbidden' }); return;
    }

    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const before = Number(req.query.before);

    let q = getFirestore().collection('devices').doc(device).collection('alerts')
      .orderBy('ts', 'desc');
    // Cursor paging rather than offset: "show me the next page" must not
    // get slower the further back you scroll.
    if (Number.isFinite(before)) q = q.where('ts', '<', before);

    const snap = await q.limit(limit).get();
    const alerts = snap.docs.map((d) => ({ id: d.id, ...d.data(), recordedAt: undefined }));

    // Not cacheable: new alerts can land at any moment, and a stale alert
    // list is worse than a slow one.
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ device, alerts, hasMore: alerts.length === limit });
  }
);

// ---------------------------------------------------------------------------
//  TEMPORARY: daily kWh snapshot at 22:00 Philippine time
//
//  A workaround, not a design. The devices publish kWh on a 12-hour
//  interval, so the value available at 22:00 can be half a day old. This
//  records the best available reading AND how stale it was, so nothing
//  downstream mistakes it for a true 22:00 meter read.
//
//  The real fix is one config value in the Lua (kWh interval_ms 12h -> 10
//  min), already applied to the Desktop copies and awaiting a deploy. Once
//  that is running everywhere, staleMs here drops under ten minutes and
//  this function can be deleted.
// ---------------------------------------------------------------------------
exports.kwhDailySnapshot = onSchedule(
  {
    region: 'asia-southeast1',
    // 22:05, NOT 22:00. The boxes take their own daily meter reading at
    // 22:00 PHT exactly (daily_at_utc = 14 in the Lua), so running on the
    // same minute is a race: whoever loses, this function reads yesterday's
    // latest/kWh and books a ~24h-stale value as today's. Five minutes is
    // far more than the push needs and still well inside the day.
    // Expressed in Asia/Manila rather than as 14:05 UTC so it stays correct
    // if the schedule is ever read by a human.
    schedule: '5 22 * * *',
    timeZone: 'Asia/Manila',
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async () => {
    const rtdb = getDatabase();
    const fs = getFirestore();
    const now = Date.now();
    const dateKey = phDateKey(now);

    const { companies, devices: sweepDevices } = await loadSweepContext();
    // device -> today's record, kept so the landlord view can be updated
    // once at the end rather than per device.
    const daily = {};

    for (const device of sweepDevices) {
      try {
        const [latestSnap, prevSnap] = await Promise.all([
          rtdb.ref(`devices/${device}/latest/kWh`).once('value'),
          // Yesterday's record, for the day-over-day delta. Ordered by the
          // document id, which is the date key, so this is the most recent
          // snapshot regardless of when it was written.
          fs.collection('devices').doc(device).collection('kwhDaily')
            .orderBy('__name__', 'desc').limit(1).get(),
        ]);

        const previous = prevSnap.empty ? null : prevSnap.docs[0].data();
        const record = buildSnapshot({
          device,
          latest: latestSnap.val(),
          previous,
          now,
        });

        // Document id IS the Philippine date, so a re-run on the same day
        // overwrites rather than creating a second reading for that day.
        await fs.collection('devices').doc(device)
          .collection('kwhDaily').doc(dateKey)
          .set({ ...record, recordedAt: FieldValue.serverTimestamp() });

        daily[device] = record;

        console.log(`kwhDailySnapshot: ${device} ${dateKey} value=${record.value} ` +
          `stale=${record.staleMs === null ? '?' : Math.round(record.staleMs / 60000) + 'min'} ` +
          `delta=${record.deltaKwh === null ? 'n/a' : record.deltaKwh.toFixed(3)}` +
          `${record.resetSuspected ? ' RESET-SUSPECTED' : ''}`);
      } catch (err) {
        console.error(`kwhDailySnapshot: ${device} failed`, err);
      }
    }

    // The landlord's billing line. Written HERE and nowhere else: these
    // figures change once a day, so having the two-minute alert sweep carry
    // them would mean rewriting a number 720 times a day to say the same
    // thing. Each writer owns its own fields of the node.
    try {
      const updates = {};
      for (const companyId of overviewCompanies(companies)) {
        const deviceIds = Object.keys(companies[companyId].devices || {});
        let total = 0;
        let known = 0;
        for (const id of deviceIds) {
          const rec = daily[id];
          if (!rec) continue;
          updates[`mallOverview/${companyId}/tenants/${id}/kwh`] = {
            date: dateKey,
            value: rec.value,
            deltaKwh: rec.deltaKwh,
            resetSuspected: Boolean(rec.resetSuspected),
            // Carried through so the mall can see WHICH tenants' figures are
            // trustworthy. A stale reading billed as a day's consumption is
            // the failure this whole daily-snapshot path exists to prevent.
            staleMs: rec.staleMs,
          };
          if (typeof rec.deltaKwh === 'number' && Number.isFinite(rec.deltaKwh)) {
            total += rec.deltaKwh;
            known += 1;
          }
        }
        updates[`mallOverview/${companyId}/totals/kwhDate`] = dateKey;
        updates[`mallOverview/${companyId}/totals/kwhToday`] =
          known > 0 ? Number(total.toFixed(3)) : null;
        // How many tenants that total actually covers. A mall total that
        // silently spans 40 of 90 units is misleading unless it says so.
        updates[`mallOverview/${companyId}/totals/kwhFrom`] = known;
      }
      if (Object.keys(updates).length > 0) await rtdb.ref().update(updates);
    } catch (err) {
      console.error('kwhDailySnapshot: overview projection failed', err);
    }
  }
);

// ---------------------------------------------------------------------------
//  ONE-SHOT: convert the archive from hourly documents to day documents.
//
//  Delete this function once it has been run. It exists because RHW01 holds
//  REAL meter history that must survive the format change - the two
//  simulated boxes can simply be discarded.
//
//  Three modes, and the destructive ones are never the default:
//    dry   - report what would happen, change nothing
//    apply - write day documents, then delete the hourly ones they replace
//    wipe  - delete every archive document for a device (simulated boxes)
//
//  Guarded by the same key as the archive relay.
// ---------------------------------------------------------------------------
exports.migrateArchive = onRequest(
  { region: 'asia-southeast1', secrets: [ARCHIVE_RELAY_KEY], timeoutSeconds: 540 },
  async (req, res) => {
    if (req.query.key !== ARCHIVE_RELAY_KEY.value()) {
      res.status(401).json({ error: 'bad key' });
      return;
    }
    const device = String(req.query.device || '');
    const mode = String(req.query.mode || 'dry');
    if (!device) { res.status(400).json({ error: 'device required' }); return; }
    if (!['dry', 'apply', 'wipe'].includes(mode)) {
      res.status(400).json({ error: 'mode must be dry, apply or wipe' });
      return;
    }

    const fs = getFirestore();
    const col = fs.collection('devices').doc(device).collection('archive');
    const snap = await col.get();

    if (mode === 'wipe') {
      let deleted = 0;
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = fs.batch();
        for (const d of snap.docs.slice(i, i + 400)) { batch.delete(d.ref); deleted += 1; }
        await batch.commit();
      }
      // The watermark must go too, or the sweep believes these hours are
      // already archived and will never rebuild them.
      await fs.collection('sweepState').doc(device).delete().catch(() => {});
      res.status(200).json({ device, mode, deleted, sweepStateCleared: true });
      return;
    }

    // Group every existing document's rows by (tag, day). Works whichever
    // format each document is in, because unpackDay reads both - so a
    // half-finished run can simply be run again.
    const byTagDay = new Map();
    let v1Docs = 0, v2Docs = 0, rows = 0;
    for (const d of snap.docs) {
      const data = d.data() || {};
      const tag = data.tag || String(d.id).split('_')[0];
      if (data.v === 2) v2Docs += 1; else v1Docs += 1;
      for (const r of AF.unpackDay(data)) {
        if (typeof r.t !== 'number') continue;
        const key = `${tag}|${AF.dayOf(r.t)}`;
        if (!byTagDay.has(key)) byTagDay.set(key, { tag, day: AF.dayOf(r.t), rows: [] });
        byTagDay.get(key).rows.push(r);
        rows += 1;
      }
    }

    const summary = {
      device, mode,
      existingDocs: snap.size, v1Docs, v2Docs, rowsFound: rows,
      dayDocsAfter: byTagDay.size,
      reduction: snap.size ? `${(snap.size / Math.max(1, byTagDay.size)).toFixed(1)}x fewer documents` : 'n/a',
    };

    if (mode === 'dry') { res.status(200).json(summary); return; }

    // Write every day document BEFORE deleting anything. A crash between
    // the two leaves duplicates, which are harmless and idempotent to
    // re-run; the reverse order would lose readings.
    let written = 0;
    for (const { tag, day, rows: dayRows } of byTagDay.values()) {
      const packed = AF.packDay({ device, tag, day, rows: dayRows });
      if (!packed) continue;
      await col.doc(AF.docIdFor(tag, day)).set({ ...packed, receivedAt: FieldValue.serverTimestamp() });
      written += 1;
    }

    const keep = new Set([...byTagDay.values()].map((x) => AF.docIdFor(x.tag, x.day)));
    let deleted = 0;
    const stale = snap.docs.filter((d) => !keep.has(d.id));
    for (let i = 0; i < stale.length; i += 400) {
      const batch = fs.batch();
      for (const d of stale.slice(i, i + 400)) { batch.delete(d.ref); deleted += 1; }
      await batch.commit();
    }

    res.status(200).json({ ...summary, written, deletedOldDocs: deleted });
  }
);
