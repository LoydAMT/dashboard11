'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const { createHandler } = require('./archiveRollups');

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
