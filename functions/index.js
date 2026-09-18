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
    getArchiveDocs: async (device, tag, hours) => {
      const fs = getFirestore();
      const col = fs.collection('devices').doc(device).collection('archive');
      const refs = hours.map((h) => col.doc(`${tag}_${h}`));
      const snaps = await fs.getAll(...refs);
      return snaps.filter((s) => s.exists).map((s) => s.data());
    },
  })
);

// Listed explicitly rather than discovered. The Admin SDK has no shallow
// read, so enumerating /devices would mean pulling every device's entire
// subtree - the single most expensive thing that could be done on a
// bandwidth-constrained database, to learn three names. Add a device here
// when one is commissioned.
const SWEEP_DEVICES = ['RHW01', 'wecon2', 'wecon3'];

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
    const sweep = createSweep({
      devices: SWEEP_DEVICES,
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
      writeArchiveHour: async (device, hour, perTag) => {
        const fs = getFirestore();
        const batch = fs.batch();
        const receivedAt = FieldValue.serverTimestamp();
        let count = 0;
        for (const [tag, tuples] of Object.entries(perTag)) {
          const ref = fs
            .collection('devices').doc(device)
            .collection('archive').doc(`${tag}_${hour}`);
          batch.set(ref, {
            device,
            tag,
            hour,
            samples: tuples.map(tupleToSampleMap),
            receivedAt,
          });
          count += 1;
        }
        await batch.commit();
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
