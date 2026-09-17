'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');

const { createHandler } = require('./archiveRollups');
const { createHandler: createReadHandler } = require('./readArchive');

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
