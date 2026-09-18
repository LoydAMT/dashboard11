'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHandler, tupleToSampleMap } = require('./archiveRollups');

const SECRET = 'test-secret-value';
// Compute a real hour-aligned epoch-ms timestamp rather than hardcoding one,
// so the test stays valid regardless of when it runs.
const HOUR = Math.floor(Date.now() / 3600000) * 3600000;

function makeReq({ method = 'POST', query = {}, body = {} } = {}) {
  return { method, query, body };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

// Minimal Firestore double: just enough of collection/doc/batch to verify
// paths and overwrite behavior, with no real network/emulator involved.
function createFakeFirestore() {
  const docs = new Map(); // path -> data

  function makeDocRef(path) {
    return {
      path,
      collection(subName) {
        return makeCollectionRef(`${path}/${subName}`);
      },
    };
  }

  function makeCollectionRef(path) {
    return {
      doc(id) {
        return makeDocRef(`${path}/${id}`);
      },
    };
  }

  return {
    collection(name) {
      return makeCollectionRef(name);
    },
    batch() {
      const ops = [];
      return {
        set(ref, data) {
          ops.push({ ref, data });
        },
        async commit() {
          for (const { ref, data } of ops) {
            docs.set(ref.path, data);
          }
        },
      };
    },
    _docs: docs,
  };
}

function makeHandler(db) {
  return createHandler({
    expectedKey: () => SECRET,
    db: () => db,
    serverTimestamp: () => 'SERVER_TIMESTAMP',
  });
}

test('valid payload writes correct doc(s) at devices/{device}/archive/{tag}_{hour}', async () => {
  const db = createFakeFirestore();
  const handler = makeHandler(db);

  const body = {
    device: 'wecon3',
    hour: HOUR,
    tags: {
      temp1: [[HOUR, 10, 12, 15, 6]],
      humidity: [
        [HOUR, 40, 45, 50, 6],
        [HOUR + 60000, 41, 46, 51, 6],
      ],
    },
  };

  const res = makeRes();
  await handler(makeReq({ query: { key: SECRET }, body }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(db._docs.size, 2);
  assert.deepEqual(db._docs.get(`devices/wecon3/archive/temp1_${HOUR}`), {
    device: 'wecon3',
    tag: 'temp1',
    hour: HOUR,
    // Stored as an array of maps, not an array of tuples - Firestore
    // rejects arrays-of-arrays ("Nested arrays are not allowed").
    samples: body.tags.temp1.map(tupleToSampleMap),
    receivedAt: 'SERVER_TIMESTAMP',
  });
  assert.deepEqual(
    db._docs.get(`devices/wecon3/archive/humidity_${HOUR}`).samples,
    body.tags.humidity.map(tupleToSampleMap)
  );
});

test('missing or wrong key is rejected with 401 and nothing is written', async () => {
  const db = createFakeFirestore();
  const handler = makeHandler(db);
  const body = { device: 'wecon3', hour: HOUR, tags: { t: [[HOUR, 1, 2, 3, 4]] } };

  for (const query of [{}, { key: 'wrong-key' }]) {
    const res = makeRes();
    await handler(makeReq({ query, body }), res);
    assert.equal(res.statusCode, 401);
  }

  assert.equal(db._docs.size, 0);
});

test('missing device / non-hour-aligned hour / tags not an object are all rejected with 400 and nothing is written', async () => {
  const db = createFakeFirestore();
  const handler = makeHandler(db);

  const cases = [
    { name: 'missing device', body: { hour: HOUR, tags: { t: [[HOUR, 1, 2, 3, 4]] } } },
    {
      name: 'non-hour-aligned hour',
      body: { device: 'wecon3', hour: HOUR + 1, tags: { t: [[HOUR, 1, 2, 3, 4]] } },
    },
    { name: 'tags not an object (array)', body: { device: 'wecon3', hour: HOUR, tags: [] } },
    { name: 'tags missing entirely', body: { device: 'wecon3', hour: HOUR } },
  ];

  for (const { name, body } of cases) {
    const res = makeRes();
    await handler(makeReq({ query: { key: SECRET }, body }), res);
    assert.equal(res.statusCode, 400, `expected 400 for case: ${name}`);
  }

  assert.equal(db._docs.size, 0);
});

test('a 2-element [timestamp, value] legacy tuple is rejected with 400, not accepted as a rollup', async () => {
  const db = createFakeFirestore();
  const handler = makeHandler(db);

  const body = {
    device: 'wecon3',
    hour: HOUR,
    tags: {
      temp1: [[HOUR, 21.5]], // old raw shape - must never pass validation
    },
  };

  const res = makeRes();
  await handler(makeReq({ query: { key: SECRET }, body }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(db._docs.size, 0);
});

test('one invalid tag fails the whole request - no partial writes of the valid tags', async () => {
  const db = createFakeFirestore();
  const handler = makeHandler(db);

  const body = {
    device: 'wecon3',
    hour: HOUR,
    tags: {
      good: [[HOUR, 1, 2, 3, 4]],
      bad: [[HOUR, 99]], // legacy 2-element shape mixed in
    },
  };

  const res = makeRes();
  await handler(makeReq({ query: { key: SECRET }, body }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(db._docs.size, 0);
});

test('non-finite numbers (NaN/Infinity) in a tuple are rejected with 400', async () => {
  const db = createFakeFirestore();
  const handler = makeHandler(db);

  const body = {
    device: 'wecon3',
    hour: HOUR,
    tags: { temp1: [[HOUR, NaN, 12, 15, 6]] },
  };

  const res = makeRes();
  await handler(makeReq({ query: { key: SECRET }, body }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(db._docs.size, 0);
});

test('resending the same device+hour+tag overwrites in place, no duplicate doc', async () => {
  const db = createFakeFirestore();
  const handler = makeHandler(db);

  const firstBody = {
    device: 'wecon3',
    hour: HOUR,
    tags: { temp1: [[HOUR, 10, 12, 15, 6]] },
  };
  await handler(makeReq({ query: { key: SECRET }, body: firstBody }), makeRes());
  assert.equal(db._docs.size, 1);

  // Resend of the same device+hour+tag after a mid-attempt reboot, with
  // (potentially) slightly different rollup content computed on retry.
  const resendBody = {
    device: 'wecon3',
    hour: HOUR,
    tags: { temp1: [[HOUR, 11, 13, 16, 6]] },
  };
  const res = makeRes();
  await handler(makeReq({ query: { key: SECRET }, body: resendBody }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(db._docs.size, 1, 'resend must overwrite, not add a second document');
  assert.deepEqual(
    db._docs.get(`devices/wecon3/archive/temp1_${HOUR}`).samples,
    resendBody.tags.temp1.map(tupleToSampleMap)
  );
});

test('tupleToSampleMap converts a 5-tuple to a plain map with no nested array (Firestore rejects arrays-of-arrays)', () => {
  assert.deepEqual(tupleToSampleMap([HOUR, 1, 2, 3, 4]), { t: HOUR, min: 1, avg: 2, max: 3, n: 4 });
});

test('written docs never contain a bare array-of-arrays value for samples', async () => {
  const db = createFakeFirestore();
  const handler = makeHandler(db);
  const body = {
    device: 'wecon3',
    hour: HOUR,
    tags: { temp1: [[HOUR, 10, 12, 15, 6]] },
  };
  await handler(makeReq({ query: { key: SECRET }, body }), makeRes());

  const stored = db._docs.get(`devices/wecon3/archive/temp1_${HOUR}`);
  for (const sample of stored.samples) {
    assert.equal(Array.isArray(sample), false, 'each sample must be a map, not an array');
  }
});

test('a Firestore write failure surfaces as 500, not 200, so the device retries', async () => {
  const failingDb = {
    batch() {
      return {
        set() {},
        async commit() {
          throw new Error('simulated firestore failure');
        },
      };
    },
  };
  const handler = makeHandler(failingDb);
  const body = { device: 'wecon3', hour: HOUR, tags: { temp1: [[HOUR, 1, 2, 3, 4]] } };

  const res = makeRes();
  await handler(makeReq({ query: { key: SECRET }, body }), res);

  assert.equal(res.statusCode, 500);
});

// =====================================================================
//  readArchive - the read side (see readArchive.js)
// =====================================================================

const { createHandler: createReadHandler, validateQuery } = require('./readArchive');

const UID = 'test-uid-123';

function makeReadReq({ method = 'GET', query = {}, headers = {} } = {}) {
  return { method, query, headers };
}

function makeReadRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    sent: null,
    set(k, v) {
      this.headers[k] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.sent = payload;
      return this;
    },
  };
}

// Defaults represent the happy path; each test overrides just the piece it
// is actually exercising.
function makeReadHandler(overrides = {}) {
  const calls = { getArchiveDocs: 0 };
  const handler = createReadHandler({
    verifyToken: overrides.verifyToken
      || (async () => ({ uid: UID, signInProvider: 'password' })),
    hasAccess: overrides.hasAccess || (async () => true),
    getArchiveDocs: overrides.getArchiveDocs
      || (async () => {
        calls.getArchiveDocs += 1;
        return [{ samples: [{ t: HOUR + 60000, min: 1, avg: 2, max: 3, n: 60 }] }];
      }),
  });
  return { handler, calls };
}

const okQuery = () => ({
  device: 'wecon3',
  tag: 'Current',
  from: String(HOUR),
  to: String(HOUR + 3600000 - 1),
});

test('readArchive: valid authorized request returns rows in the dashboard row shape', async () => {
  const { handler } = makeReadHandler({
    getArchiveDocs: async () => [
      { samples: [{ t: HOUR + 120000, min: 5, avg: 6, max: 7, n: 60 }] },
      { samples: [{ t: HOUR + 60000, min: 1, avg: 2, max: 3, n: 60 }] },
    ],
  });
  const res = makeReadRes();
  await handler(makeReadReq({ query: okQuery(), headers: { 'x-id-token': 'good' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.device, 'wecon3');
  assert.equal(res.body.tag, 'Current');
  // Sorted by t regardless of what order the documents came back in.
  assert.deepEqual(res.body.rows, [
    { t: HOUR + 60000, min: 1, avg: 2, max: 3, n: 60 },
    { t: HOUR + 120000, min: 5, avg: 6, max: 7, n: 60 },
  ]);
});

test('readArchive: samples outside the requested window are clipped out', async () => {
  const { handler } = makeReadHandler({
    getArchiveDocs: async () => [
      {
        samples: [
          { t: HOUR - 60000, min: 9, avg: 9, max: 9, n: 60 },      // before `from`
          { t: HOUR + 60000, min: 1, avg: 2, max: 3, n: 60 },      // in window
          { t: HOUR + 3600000 + 60000, min: 8, avg: 8, max: 8, n: 60 }, // after `to`
        ],
      },
    ],
  });
  const res = makeReadRes();
  await handler(makeReadReq({ query: okQuery(), headers: { 'x-id-token': 'good' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rows.length, 1);
  assert.equal(res.body.rows[0].t, HOUR + 60000);
});

test('readArchive: missing id token is rejected with 401 and never reads Firestore', async () => {
  const { handler, calls } = makeReadHandler();
  const res = makeReadRes();
  await handler(makeReadReq({ query: okQuery() }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(calls.getArchiveDocs, 0);
});

test('readArchive: an unverifiable token is rejected with 401 and never reads Firestore', async () => {
  const { handler, calls } = makeReadHandler({
    verifyToken: async () => {
      throw new Error('bad signature');
    },
  });
  const res = makeReadRes();
  await handler(makeReadReq({ query: okQuery(), headers: { 'x-id-token': 'forged' } }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(calls.getArchiveDocs, 0);
});

test('readArchive: an anonymous sign-in is rejected with 403, matching the RTDB rule', async () => {
  const { handler, calls } = makeReadHandler({
    verifyToken: async () => ({ uid: UID, signInProvider: 'anonymous' }),
  });
  const res = makeReadRes();
  await handler(makeReadReq({ query: okQuery(), headers: { 'x-id-token': 'anon' } }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(calls.getArchiveDocs, 0);
});

test('readArchive: a signed-in user without access to THIS device gets 403 and no data', async () => {
  const { handler, calls } = makeReadHandler({ hasAccess: async () => false });
  const res = makeReadRes();
  await handler(makeReadReq({ query: okQuery(), headers: { 'x-id-token': 'good' } }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.rows, undefined);
  assert.equal(calls.getArchiveDocs, 0, 'must not touch Firestore before the access check passes');
});

test('readArchive: bad or missing parameters are rejected with 400', async () => {
  const cases = [
    { name: 'no device', query: { tag: 'Current', from: String(HOUR), to: String(HOUR + 1) } },
    { name: 'no tag', query: { device: 'wecon3', from: String(HOUR), to: String(HOUR + 1) } },
    { name: 'non-numeric from', query: { device: 'wecon3', tag: 'Current', from: 'abc', to: String(HOUR) } },
    { name: 'to before from', query: { device: 'wecon3', tag: 'Current', from: String(HOUR), to: String(HOUR - 3600000) } },
    {
      name: 'range wider than MAX_HOURS',
      query: { device: 'wecon3', tag: 'Current', from: String(HOUR), to: String(HOUR + 801 * 3600000) },
    },
  ];

  for (const { name, query } of cases) {
    const { handler, calls } = makeReadHandler();
    const res = makeReadRes();
    await handler(makeReadReq({ query, headers: { 'x-id-token': 'good' } }), res);
    assert.equal(res.statusCode, 400, `expected 400 for case: ${name}`);
    assert.equal(calls.getArchiveDocs, 0, `must not read Firestore for case: ${name}`);
  }
});

test('readArchive: a CORS preflight is answered without requiring a token', async () => {
  const { handler } = makeReadHandler();
  const res = makeReadRes();
  await handler(makeReadReq({ method: 'OPTIONS' }), res);

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.ok(res.headers['Access-Control-Allow-Headers'].includes('X-Id-Token'));
});

test('readArchive: a Firestore failure surfaces as 500, not as an empty-but-successful result', async () => {
  const { handler } = makeReadHandler({
    getArchiveDocs: async () => {
      throw new Error('simulated firestore failure');
    },
  });
  const res = makeReadRes();
  await handler(makeReadReq({ query: okQuery(), headers: { 'x-id-token': 'good' } }), res);

  assert.equal(res.statusCode, 500);
  // An empty 200 would read downstream as "this window genuinely has no
  // history", silently drawing a gap instead of reporting a fault.
  assert.notEqual(res.statusCode, 200);
});

test('readArchive: validateQuery expands the window into whole hour buckets', () => {
  const v = validateQuery({ device: 'd', tag: 't', from: String(HOUR), to: String(HOUR + 2 * 3600000) });
  assert.equal(v.ok, true);
  assert.deepEqual(v.hours, [HOUR, HOUR + 3600000, HOUR + 2 * 3600000]);
});

// --- response caching -------------------------------------------------
//
// Archive rows for a closed, fully-archived hour never change, so the
// browser is allowed to keep them. Both halves of that sentence are load
// bearing, and each gets a test: an hour that has not closed yet may still
// gain rows, and an hour missing its document is one the device has not
// archived yet - caching either for a year would freeze a gap into place.

const { cacheControlFor } = require('./readArchive');

const PAST_HOUR = HOUR - 5 * 3600000;

test('readArchive: a closed, fully-archived window is cacheable for a long time', () => {
  const cc = cacheControlFor({ to: PAST_HOUR + 3599999, hourCount: 1, docCount: 1, now: Date.now() });
  assert.match(cc, /immutable/);
  assert.match(cc, /^private/);   // never shared-cacheable: see the note in readArchive.js
});

test('readArchive: a window reaching into the current hour is only briefly cacheable', () => {
  const cc = cacheControlFor({ to: HOUR + 60000, hourCount: 1, docCount: 1, now: Date.now() });
  assert.equal(cc, 'private, max-age=60');
});

test('readArchive: a closed window with a missing hour is NOT cached long - those rows are still coming', () => {
  // Three hours requested, two archived: the device is behind (wecon3 has
  // run hours behind before). Caching this for a year would make the gap
  // permanent for that browser even after the hour is finally archived.
  const cc = cacheControlFor({ to: PAST_HOUR + 3 * 3600000 - 1, hourCount: 3, docCount: 2, now: Date.now() });
  assert.equal(cc, 'private, max-age=60');
});

test('readArchive: a successful response carries Cache-Control and varies on the token', async () => {
  const { handler } = makeReadHandler();
  const res = makeReadRes();
  await handler(makeReadReq({ query: okQuery(), headers: { 'x-id-token': 'good' } }), res);

  assert.equal(res.statusCode, 200);
  // Keyed on the token too, so a second person on a shared browser profile
  // cannot be served rows for a device they have no access to.
  assert.equal(res.headers['Vary'], 'X-Id-Token');
  assert.match(res.headers['Cache-Control'], /^private/);
});

test('readArchive: a past window whose hours are all present gets the immutable header end to end', async () => {
  const { handler } = makeReadHandler({
    getArchiveDocs: async () => [{ samples: [{ t: PAST_HOUR + 60000, min: 1, avg: 2, max: 3, n: 60 }] }],
  });
  const res = makeReadRes();
  await handler(
    makeReadReq({
      query: { device: 'wecon3', tag: 'Current', from: String(PAST_HOUR), to: String(PAST_HOUR + 3599999) },
      headers: { 'x-id-token': 'good' },
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Cache-Control'], /immutable/);
});

test('readArchive: a refused request does not get a caching header at all', async () => {
  const { handler } = makeReadHandler({ hasAccess: async () => false });
  const res = makeReadRes();
  await handler(makeReadReq({ query: okQuery(), headers: { 'x-id-token': 'good' } }), res);

  assert.equal(res.statusCode, 403);
  // A cached 403 would outlive the access grant that fixes it.
  assert.equal(res.headers['Cache-Control'], undefined);
});

// --- archiveSweep: scheduled server-side archive + prune ---------------
//
// This one DELETES data, so the tests are mostly about what must never
// happen: never prune an hour Firestore has not confirmed, never advance a
// watermark past an hour that failed, never touch the recent window the
// charts read live.

const { createSweep, toTuples } = require('./archiveSweep');

const H = 3600000;
const NOW = Math.floor(Date.now() / H) * H + 1800000;   // mid-hour, deterministic

function makeSweepEnv(overrides = {}) {
  // Six hours of rollups, oldest 200h back, so there is a real backlog.
  const oldest = Math.floor(NOW / H) * H - 200 * H;
  const calls = { archived: [], deleted: [], stateWrites: [] };
  const state = { value: overrides.initialState ?? null };

  const env = {
    devices: overrides.devices || ['devA'],
    now: () => NOW,
    keepHours: overrides.keepHours ?? 48,
    maxArchiveHours: overrides.maxArchiveHours ?? 5,
    maxPruneHours: overrides.maxPruneHours ?? 5,
    readTagKeys: overrides.readTagKeys || (async () => ['Current']),
    readOldestRollupHour: overrides.readOldestRollupHour || (async () => oldest),
    readHourRollups:
      overrides.readHourRollups
      || (async (_d, _t, hour) => ({ [String(hour + 60000)]: { min: 1, avg: 2, max: 3, n: 60 } })),
    writeArchiveHour:
      overrides.writeArchiveHour
      || (async (device, hour) => { calls.archived.push(hour); return 1; }),
    deleteHourRollups:
      overrides.deleteHourRollups
      || (async (_d, _t, hour) => { calls.deleted.push(hour); return 60; }),
    readState: async () => state.value,
    writeState: async (_d, s) => { state.value = s; calls.stateWrites.push({ ...s }); },
  };
  return { sweep: createSweep(env), calls, state, oldest };
}

test('archiveSweep: never prunes an hour it has not archived', async () => {
  const { sweep, calls } = makeSweepEnv({ maxArchiveHours: 3, maxPruneHours: 99 });
  await sweep();

  assert.equal(calls.archived.length, 3);
  // Pruning is capped by arHour, so it can never outrun the archive even
  // with a generous prune budget. This is THE safety property.
  assert.ok(calls.deleted.length <= calls.archived.length);
  for (const h of calls.deleted) {
    assert.ok(calls.archived.includes(h), `pruned ${h} without archiving it`);
  }
});

test('archiveSweep: leaves the recent keepHours window in RTDB for live charts', async () => {
  const { sweep, calls } = makeSweepEnv({ maxArchiveHours: 500, maxPruneHours: 500, keepHours: 48 });
  await sweep();

  const cutoff = Math.floor(NOW / H) * H - 48 * H;
  for (const h of calls.deleted) {
    assert.ok(h < cutoff, `pruned ${h}, inside the ${48}h live window`);
  }
});

test('archiveSweep: a failed read does NOT advance the watermark past that hour', async () => {
  let n = 0;
  const { sweep, calls, state } = makeSweepEnv({
    maxArchiveHours: 10,
    readHourRollups: async (_d, _t, hour) => {
      n += 1;
      if (n === 3) throw new Error('simulated RTDB read failure');
      return { [String(hour + 60000)]: { min: 1, avg: 2, max: 3, n: 60 } };
    },
  });
  const [res] = await sweep();

  assert.match(res.error, /simulated RTDB read failure/);
  // Two hours completed before the failure; the third did not, so the
  // watermark must still be sitting on hour two.
  assert.equal(res.archived, 2);
  assert.equal(state.value.arHour, calls.archived[1]);
  // And progress that DID complete is saved, not thrown away.
  assert.equal(calls.stateWrites.length, 1);
});

test('archiveSweep: resumes from the stored watermark instead of restarting', async () => {
  const base = Math.floor(NOW / H) * H - 100 * H;
  const { sweep, calls } = makeSweepEnv({
    initialState: { arHour: base, rpHour: base },
    maxArchiveHours: 2,
  });
  await sweep();

  assert.deepEqual(calls.archived, [base + H, base + 2 * H]);
});

test('archiveSweep: an hour with no rollups is skipped but still advances', async () => {
  const { sweep, calls, state } = makeSweepEnv({
    maxArchiveHours: 4,
    readHourRollups: async () => ({}),     // every hour empty
  });
  const [res] = await sweep();

  assert.equal(res.archived, 4);
  assert.equal(calls.archived.length, 0);  // nothing written
  assert.ok(state.value.arHour > 0);       // but it moved on
});

test('archiveSweep: one device failing does not stop the others', async () => {
  const { sweep } = makeSweepEnv({
    devices: ['devA', 'devB'],
    readTagKeys: async (d) => {
      if (d === 'devA') throw new Error('devA unreachable');
      return ['Current'];
    },
  });
  const results = await sweep();
  assert.equal(results.length, 2);
  assert.equal(results[1].device, 'devB');
});

test('archiveSweep: toTuples ignores the sibling raw subtree and malformed rows', () => {
  const tuples = toTuples({
    '1700000000000': { min: 1, avg: 2, max: 3, n: 60 },
    raw: { '1700000000001': 5 },                       // the raw/ sibling
    '1700000060000': { min: 1, avg: 'x', max: 3, n: 1 }, // malformed
    '1700000120000': { min: 4, avg: 5, max: 6, n: 30 },
  });
  assert.equal(tuples.length, 2);
  assert.deepEqual(tuples[0], [1700000000000, 1, 2, 3, 60]);
  assert.ok(tuples[0][0] < tuples[1][0]);   // sorted
});

// --- projectCompanyAccess: companies -> the flat nodes rules can read ----
//
// This code grants and revokes access, so the tests are about the failure
// modes that matter: never silently keep a revoked grant, never lock out an
// admin, and never downgrade someone who holds operator elsewhere.

const { computeProjection, toUpdates } = require('./projectCompanyAccess');

const KHENT = 'khent-uid';
const ALICE = 'alice-uid';
const BOB = 'bob-uid';

test('projectCompanyAccess: members get their company\'s devices, nobody else\'s', () => {
  const p = computeProjection({
    companies: {
      c1: { devices: { RHW01: true }, members: { [ALICE]: 'viewer' } },
      c2: { devices: { wecon2: true }, members: { [BOB]: 'operator' } },
    },
  });

  assert.deepEqual(Object.keys(p.deviceGrants.RHW01.viewers), [ALICE]);
  assert.deepEqual(Object.keys(p.deviceGrants.wecon2.operators), [BOB]);
  // Alice must not appear on wecon2 at all.
  assert.equal(p.deviceGrants.wecon2.viewers[ALICE], undefined);
  assert.equal(p.access[ALICE].wecon2, undefined);
});

test('projectCompanyAccess: operator wins when two companies grant the same device', () => {
  const p = computeProjection({
    companies: {
      c1: { devices: { RHW01: true }, members: { [ALICE]: 'viewer' } },
      c2: { devices: { RHW01: true }, members: { [ALICE]: 'operator' } },
    },
  });
  assert.equal(p.deviceGrants.RHW01.operators[ALICE], true);
  // and must NOT also sit in viewers, which would be contradictory state
  assert.equal(p.deviceGrants.RHW01.viewers[ALICE], undefined);
  assert.equal(p.access[ALICE].RHW01, 'operator');
});

test('projectCompanyAccess: removing a member actually revokes - the whole point', () => {
  const before = computeProjection({
    companies: { c1: { devices: { RHW01: true }, members: { [ALICE]: 'viewer', [BOB]: 'viewer' } } },
  });
  assert.equal(before.deviceGrants.RHW01.viewers[BOB], true);

  const after = computeProjection({
    companies: { c1: { devices: { RHW01: true }, members: { [ALICE]: 'viewer' } } },
  });
  assert.equal(after.deviceGrants.RHW01.viewers[BOB], undefined);

  // and the flat update must NULL Bob's index, not merely omit it - an
  // omitted key leaves the old node in place.
  const up = toUpdates(after, { knownUids: [ALICE, BOB] });
  assert.equal(up[`access/${BOB}`], null);
  assert.equal(up[`userCompanies/${BOB}`], null);
  assert.deepEqual(up[`access/${ALICE}`], { RHW01: 'viewer' });
});

test('projectCompanyAccess: a company losing every member clears the device lists', () => {
  const p = computeProjection({ companies: { c1: { devices: { RHW01: true }, members: {} } } });
  const up = toUpdates(p);
  assert.equal(up['devices/RHW01/viewers'], null);
  assert.equal(up['devices/RHW01/operators'], null);
});

test('projectCompanyAccess: an admin is never removed by a company edit', () => {
  // Khent holds an operator grant on RHW01 but belongs to no company.
  const p = computeProjection({
    companies: { c1: { devices: { RHW01: true }, members: { [ALICE]: 'viewer' } } },
    adminUids: [KHENT],
    existing: {
      deviceGrants: { RHW01: { viewers: {}, operators: { [KHENT]: true } } },
      access: { [KHENT]: { RHW01: 'operator', wecon2: 'operator' } },
    },
  });

  assert.equal(p.deviceGrants.RHW01.operators[KHENT], true, 'admin was dropped');
  assert.equal(p.access[KHENT].wecon2, 'operator', 'admin index was dropped');
  // Alice is unaffected
  assert.equal(p.deviceGrants.RHW01.viewers[ALICE], true);
});

test('projectCompanyAccess: a NON-admin in existing state is NOT preserved', () => {
  // The mirror image of the test above: preservation must apply only to
  // admins, or revocation would never take effect for anyone.
  const p = computeProjection({
    companies: { c1: { devices: { RHW01: true }, members: {} } },
    adminUids: [KHENT],
    existing: {
      deviceGrants: { RHW01: { viewers: { [BOB]: true }, operators: {} } },
      access: { [BOB]: { RHW01: 'viewer' } },
    },
  });
  assert.equal(p.deviceGrants.RHW01.viewers[BOB], undefined);
  assert.equal(p.access[BOB], undefined);
});

test('projectCompanyAccess: userCompanies index lists every company a uid belongs to', () => {
  const p = computeProjection({
    companies: {
      c1: { devices: { RHW01: true }, members: { [ALICE]: 'viewer' } },
      c2: { devices: { wecon2: true }, members: { [ALICE]: 'operator' } },
    },
  });
  assert.deepEqual(Object.keys(p.userCompanies[ALICE]).sort(), ['c1', 'c2']);
});

test('projectCompanyAccess: malformed company entries are skipped, not thrown on', () => {
  const p = computeProjection({
    companies: { good: { devices: { RHW01: true }, members: { [ALICE]: 'viewer' } }, bad: null, alsoBad: 'nope' },
  });
  assert.equal(p.deviceGrants.RHW01.viewers[ALICE], true);
});

// --- alertEngine: server-side alert detection ---------------------------
//
// The properties that matter for a record people will rely on: fire on
// transitions only, catch a spike that lasts seconds, never duplicate, and
// notice a box that has gone quiet.

const { evaluate, classify, alertId } = require('./alertEngine');

const M = 60000;
const T0 = 1789700000000 - (1789700000000 % M);
const win = (minute, tag, r) => ({ minute, byTag: { [tag]: r } });

test('alertEngine: fires once on the transition, not every minute it stays high', () => {
  const rules = { Current: { hi: 10 } };
  const windows = [
    win(T0 + 0 * M, 'Current', { min: 1, avg: 2, max: 3, n: 60 }),
    win(T0 + 1 * M, 'Current', { min: 9, avg: 11, max: 14, n: 60 }),   // goes high
    win(T0 + 2 * M, 'Current', { min: 10, avg: 12, max: 15, n: 60 }),  // stays high
    win(T0 + 3 * M, 'Current', { min: 10, avg: 12, max: 15, n: 60 }),  // stays high
  ];
  const { events, state } = evaluate({ device: 'd', windows, rules, status: { lastSeen: T0 + 3 * M } , now: T0 + 3 * M });

  const alarms = events.filter((e) => e.kind === 'alarm-high');
  assert.equal(alarms.length, 1, 'a sustained alarm must not repeat every minute');
  assert.equal(alarms[0].ts, T0 + M);
  assert.equal(state.tags.Current, 'high');
});

test('alertEngine: clears when the value returns, and can fire again after', () => {
  const rules = { Current: { hi: 10 } };
  const windows = [
    win(T0 + 0 * M, 'Current', { min: 9, avg: 11, max: 14, n: 60 }),   // high
    win(T0 + 1 * M, 'Current', { min: 1, avg: 2, max: 3, n: 60 }),     // clear
    win(T0 + 2 * M, 'Current', { min: 9, avg: 11, max: 20, n: 60 }),   // high again
  ];
  const { events } = evaluate({ device: 'd', windows, rules, status: { lastSeen: T0 + 2 * M }, now: T0 + 2 * M });
  assert.deepEqual(events.map((e) => e.kind), ['alarm-high', 'alarm-clear', 'alarm-high']);
});

test('alertEngine: a two-second excursion inside a minute is still caught', () => {
  // avg sits comfortably under the limit; only max betrays the spike. This
  // is why the engine reads rollups rather than polling latest/.
  const rules = { Current: { hi: 10 } };
  const windows = [win(T0, 'Current', { min: 1, avg: 2.1, max: 47, n: 60 })];
  const { events } = evaluate({ device: 'd', windows, rules, status: { lastSeen: T0 }, now: T0 });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'alarm-high');
  assert.equal(events[0].value, 47);
});

test('alertEngine: low limit uses min, not average', () => {
  const rules = { Voltage: { lo: 200 } };
  const windows = [win(T0, 'Voltage', { min: 180, avg: 229, max: 240, n: 60 })];
  const { events } = evaluate({ device: 'd', windows, rules, status: { lastSeen: T0 }, now: T0 });
  assert.equal(events[0].kind, 'alarm-low');
  assert.equal(events[0].value, 180);
});

test('alertEngine: resuming from stored state does not re-fire an existing alarm', () => {
  const rules = { Current: { hi: 10 } };
  const windows = [win(T0 + 5 * M, 'Current', { min: 11, avg: 12, max: 13, n: 60 })];
  const { events } = evaluate({
    device: 'd', windows, rules,
    prevState: { tags: { Current: 'high' }, lastMinute: T0 + 4 * M },
    status: { lastSeen: T0 + 5 * M }, now: T0 + 5 * M,
  });
  assert.equal(events.length, 0, 'already-high tag re-fired after a restart');
});

test('alertEngine: minutes at or before the watermark are skipped', () => {
  const rules = { Current: { hi: 10 } };
  const windows = [
    win(T0 + 1 * M, 'Current', { min: 11, avg: 12, max: 13, n: 60 }),  // already processed
    win(T0 + 2 * M, 'Current', { min: 1, avg: 2, max: 3, n: 60 }),
  ];
  const { events, state } = evaluate({
    device: 'd', windows, rules,
    prevState: { tags: {}, lastMinute: T0 + 1 * M },
    status: { lastSeen: T0 + 2 * M }, now: T0 + 2 * M,
  });
  assert.equal(events.length, 0);
  assert.equal(state.lastMinute, T0 + 2 * M);
});

test('alertEngine: a tag with no rule never alerts, however extreme', () => {
  const windows = [win(T0, 'Current', { min: -9999, avg: 0, max: 9999, n: 60 })];
  const { events } = evaluate({ device: 'd', windows, rules: {}, status: { lastSeen: T0 }, now: T0 });
  assert.equal(events.length, 0);
});

test('alertEngine: notices a box that has gone quiet, and its return', () => {
  const now = T0 + 10 * M;
  const down = evaluate({ device: 'd', windows: [], rules: {}, status: { lastSeen: now - 5 * M }, now });
  assert.equal(down.events.length, 1);
  assert.equal(down.events[0].kind, 'offline');
  assert.equal(down.state.offline, true);

  // still down: must not repeat
  const still = evaluate({
    device: 'd', windows: [], rules: {},
    prevState: down.state, status: { lastSeen: now - 6 * M }, now: now + M,
  });
  assert.equal(still.events.length, 0, 'offline repeated while still offline');

  const up = evaluate({
    device: 'd', windows: [], rules: {},
    prevState: down.state, status: { lastSeen: now + M }, now: now + M,
  });
  assert.equal(up.events[0].kind, 'online');
  assert.equal(up.state.offline, false);
});

test('alertEngine: alert ids are deterministic so a re-run cannot duplicate', () => {
  const ev = { ts: T0, tagKey: 'Current', kind: 'alarm-high' };
  assert.equal(alertId(ev), alertId({ ...ev }));
  assert.notEqual(alertId(ev), alertId({ ...ev, kind: 'alarm-clear' }));
  // device-level events have no tag and must still get a stable id
  assert.equal(alertId({ ts: T0, tagKey: null, kind: 'offline' }), `${T0}__device_offline`);
});

test('alertEngine: classify needs a rule, and reports unknown rather than ok', () => {
  assert.equal(classify({ min: 1, avg: 2, max: 3 }, null), 'none');
  assert.equal(classify({ min: 1, avg: 2, max: 3 }, {}), 'none');
  assert.equal(classify(null, { hi: 10 }), 'unknown');
  assert.equal(classify({ min: 1, avg: 2, max: 3 }, { hi: 10 }), 'ok');
});

// --- alertEngine: spike detection ---------------------------------------
//
// This is the alert that actually fires in practice. No tag on any device
// has a limit configured, so without spikes the server log would be empty
// on a healthy site - which is exactly what was observed after the first
// deploy.

const { isSpike } = require('./alertEngine');

const flat = (v, n = 12) => Array.from({ length: n }, () => v);

test('alertEngine: a steady tag that jumps is a spike', () => {
  assert.equal(isSpike(flat(230), 400), true);
});

test('alertEngine: ordinary noise is not a spike', () => {
  const noisy = [230, 230.4, 229.6, 230.2, 229.8, 230.1, 229.9, 230.3, 230, 229.7];
  assert.equal(isSpike(noisy, 230.5), false, 'ordinary wobble must not alert');
});

test('alertEngine: a tiny wobble on a near-constant tag is not a spike', () => {
  // sd is ~0 here, so a pure z-score would call any change infinite sigma.
  // MIN_DELTA_FRACTION is what stops that.
  assert.equal(isSpike(flat(230), 230.5), false);
});

test('alertEngine: too short a baseline never spikes', () => {
  assert.equal(isSpike([230, 230, 230], 999), false, 'fired before a baseline existed');
});

test('alertEngine: spike fires on rollups and carries the extreme, not the average', () => {
  const windows = [];
  const T = T0 + 100 * M;
  // 10 steady minutes to build a baseline...
  for (let i = 0; i < 10; i++) {
    windows.push(win(T + i * M, 'Current', { min: 2, avg: 2, max: 2, n: 60 }));
  }
  // ...then a minute whose AVERAGE is unremarkable but whose MAX is not.
  windows.push(win(T + 10 * M, 'Current', { min: 2, avg: 2.2, max: 40, n: 60 }));

  const { events, state } = evaluate({
    device: 'd', windows, rules: {},
    status: { lastSeen: T + 10 * M }, now: T + 10 * M,
  });

  const spikes = events.filter((e) => e.kind === 'spike');
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].value, 40, 'reported the average instead of the excursion');
  assert.equal(spikes[0].tagKey, 'Current');
  assert.ok(state.buffers.Current.length > 0, 'baseline was not carried forward');
});

test('alertEngine: spike is suppressed while the tag is already in limit alarm', () => {
  const windows = [];
  const T = T0 + 200 * M;
  for (let i = 0; i < 10; i++) {
    windows.push(win(T + i * M, 'Current', { min: 2, avg: 2, max: 2, n: 60 }));
  }
  windows.push(win(T + 10 * M, 'Current', { min: 2, avg: 2.2, max: 40, n: 60 }));

  const { events } = evaluate({
    device: 'd', windows,
    rules: { Current: { hi: 10 } },           // the same excursion trips the limit
    status: { lastSeen: T + 10 * M }, now: T + 10 * M,
  });

  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('alarm-high'), 'limit alarm should still fire');
  assert.equal(kinds.filter((k) => k === 'spike').length, 0,
    'one excursion must not be reported twice');
});

test('alertEngine: spike baseline survives a restart via stored state', () => {
  const T = T0 + 300 * M;
  const { events } = evaluate({
    device: 'd',
    windows: [win(T, 'Current', { min: 2, avg: 2.1, max: 40, n: 60 })],
    rules: {},
    prevState: { buffers: { Current: flat(2, 12) }, lastMinute: T - M },
    status: { lastSeen: T }, now: T,
  });
  assert.equal(events.filter((e) => e.kind === 'spike').length, 1,
    'a restart should not need 8 fresh minutes before it can detect again');
});
