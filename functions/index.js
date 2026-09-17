'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');

const { createHandler, tupleToSampleMap } = require('./archiveRollups');
const { createHandler: createReadHandler } = require('./readArchive');
const { createSweep, hourOf, HOUR_MS } = require('./archiveSweep');

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
