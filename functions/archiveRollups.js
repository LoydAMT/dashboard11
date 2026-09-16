'use strict';

// Validation + request handling for the archiveRollups relay, kept separate
// from index.js so tests can exercise it with fake req/res/db objects
// instead of standing up a real HTTPS function or Firestore instance.

const TUPLE_LENGTH = 5;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A rollup sample is [minuteTs, min, avg, max, n] - exactly 5 finite
// numbers. The legacy raw format was [timestamp, value] (length 2) and
// must never be accepted here, since that's exactly the shape retiring.
function isValidTuple(tuple) {
  return Array.isArray(tuple) && tuple.length === TUPLE_LENGTH && tuple.every(isFiniteNumber);
}

function validatePayload(body) {
  if (!isPlainObject(body)) {
    return { ok: false, reason: 'request body must be a JSON object' };
  }

  const { device, hour, tags } = body;

  if (typeof device !== 'string' || device.length === 0) {
    return { ok: false, reason: 'device must be a non-empty string' };
  }

  if (!Number.isInteger(hour) || hour % 3600000 !== 0) {
    return { ok: false, reason: 'hour must be an hour-aligned epoch-ms integer' };
  }

  if (!isPlainObject(tags)) {
    return { ok: false, reason: 'tags must be an object' };
  }

  const tagKeys = Object.keys(tags);
  if (tagKeys.length === 0) {
    return { ok: false, reason: 'tags must have at least one entry' };
  }

  for (const tagKey of tagKeys) {
    const samples = tags[tagKey];
    if (!Array.isArray(samples)) {
      return { ok: false, reason: `tag "${tagKey}" must be an array of samples` };
    }
    for (const tuple of samples) {
      if (!isValidTuple(tuple)) {
        return {
          ok: false,
          reason: `tag "${tagKey}" contains a sample that is not a 5-element finite numeric tuple`,
        };
      }
    }
  }

  return { ok: true };
}

function tupleToSampleMap([t, min, avg, max, n]) {
  return { t, min, avg, max, n };
}

// db and serverTimestamp are injected so tests can supply fakes instead of
// a live Firestore connection. expectedKey is a function (not a plain
// value) because it's called lazily per-request - a defineSecret() value
// must never be read at module load time.
function createHandler({ expectedKey, db, serverTimestamp }) {
  return async function archiveRollupsHandler(req, res) {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    const providedKey = req.query ? req.query.key : undefined;
    if (!providedKey || providedKey !== expectedKey()) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const validation = validatePayload(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.reason });
      return;
    }

    const { device, hour, tags } = req.body;
    const firestore = db();

    try {
      const batch = firestore.batch();
      const receivedAt = serverTimestamp();

      for (const [tag, samples] of Object.entries(tags)) {
        const docId = `${tag}_${hour}`;
        const ref = firestore.collection('devices').doc(device).collection('archive').doc(docId);
        // Firestore rejects arrays-of-arrays ("Nested arrays are not
        // allowed"), so each [minuteTs, min, avg, max, n] tuple is stored
        // as a map instead - same values, same order, just not a bare array.
        const firestoreSamples = samples.map(tupleToSampleMap);
        batch.set(ref, { device, tag, hour, samples: firestoreSamples, receivedAt });
      }

      await batch.commit();
    } catch (err) {
      console.error('archiveRollups: firestore write failed', err);
      res.status(500).json({ error: 'internal error' });
      return;
    }

    res.status(200).json({ ok: true, device, hour, tags: Object.keys(tags).length });
  };
}

module.exports = { validatePayload, createHandler, tupleToSampleMap, TUPLE_LENGTH };
