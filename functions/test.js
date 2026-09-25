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
  assert.ok(state.buffers.Current.hi.length > 0, 'high baseline was not carried forward');
  assert.ok(state.buffers.Current.lo.length > 0, 'low baseline was not carried forward');
});

test('alertEngine: an ordinary tag does NOT spike every single minute', () => {
  // THE REGRESSION THIS GUARDS. The first version compared each minute's MAX
  // against a baseline of past AVERAGES. A minute's maximum sits above the
  // mean of past averages by construction on any tag that moves at all, so
  // the test fired on nearly every minute of every tag and the alert log
  // filled with spikes for every device on every sweep - burying the alerts
  // that actually mattered.
  //
  // This is a perfectly ordinary tag: steady average, real within-minute
  // spread, no excursion anywhere. It must produce NO spikes.
  const T = T0 + 400 * M;
  const windows = [];
  for (let i = 0; i < 40; i++) {
    const wobble = (i % 5) * 0.03;
    windows.push(win(T + i * M, 'Current', {
      min: 3.0 + wobble, avg: 4.0 + wobble, max: 5.2 + wobble, n: 60,
    }));
  }
  const { events } = evaluate({
    device: 'd', windows, rules: {},
    status: { lastSeen: T + 39 * M }, now: T + 39 * M,
  });
  const spikes = events.filter((e) => e.kind === 'spike');
  assert.equal(spikes.length, 0,
    `steady tag produced ${spikes.length} spike(s) in 40 minutes`);
});

test('alertEngine: a REAL excursion still fires after the bias fix', () => {
  // The other half of the same guard: quietening the false positives must
  // not quieten the true ones.
  const T = T0 + 500 * M;
  const windows = [];
  for (let i = 0; i < 20; i++) {
    windows.push(win(T + i * M, 'Current', { min: 3.0, avg: 4.0, max: 5.2, n: 60 }));
  }
  windows.push(win(T + 20 * M, 'Current', { min: 3.0, avg: 4.4, max: 48, n: 60 }));
  const { events } = evaluate({
    device: 'd', windows, rules: {},
    status: { lastSeen: T + 20 * M }, now: T + 20 * M,
  });
  const spikes = events.filter((e) => e.kind === 'spike');
  assert.equal(spikes.length, 1, 'a genuine excursion must still be caught');
  assert.equal(spikes[0].value, 48);
});

test('alertEngine: a sag is caught as well as a surge', () => {
  const T = T0 + 600 * M;
  const windows = [];
  for (let i = 0; i < 20; i++) {
    windows.push(win(T + i * M, 'Voltage', { min: 228, avg: 230, max: 232, n: 60 }));
  }
  windows.push(win(T + 20 * M, 'Voltage', { min: 140, avg: 229, max: 232, n: 60 }));
  const { events } = evaluate({
    device: 'd', windows, rules: {},
    status: { lastSeen: T + 20 * M }, now: T + 20 * M,
  });
  const spikes = events.filter((e) => e.kind === 'spike');
  assert.equal(spikes.length, 1, 'a collapse in the minute minimum must register');
  assert.equal(spikes[0].value, 140, 'reported the wrong extreme');
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
    prevState: {
      buffers: { Current: { hi: flat(2, 12), lo: flat(2, 12) } },
      lastMinute: T - M,
    },
    status: { lastSeen: T }, now: T,
  });
  assert.equal(events.filter((e) => e.kind === 'spike').length, 1,
    'a restart should not need 8 fresh minutes before it can detect again');
});

// --- kwhSnapshot: TEMPORARY daily meter reading -------------------------
//
// The properties that matter for something a bill might be built on: never
// report negative usage, never hide how stale the reading was, and put the
// reading on the right Philippine calendar day.

const { buildSnapshot, phDateKey } = require('./kwhSnapshot');

const AT_2200_PHT = Date.parse('2026-09-19T14:00:00Z');

test('kwhSnapshot: 22:00 PHT lands on that same Philippine day', () => {
  assert.equal(phDateKey(AT_2200_PHT), '2026-09-19');
  // 00:30 PHT is the NEXT day even though it is still the 19th in UTC
  assert.equal(phDateKey(Date.parse('2026-09-19T16:30:00Z')), '2026-09-20');
  // and 07:00 PHT is still the same day, an hour before UTC rolls over
  assert.equal(phDateKey(Date.parse('2026-09-19T23:00:00Z')), '2026-09-20');
});

test('kwhSnapshot: records how stale the reading was', () => {
  const s = buildSnapshot({
    device: 'RHW01',
    latest: { value: 49.6, ts: AT_2200_PHT - 3 * 3600000 },   // 3h old
    now: AT_2200_PHT,
  });
  assert.equal(s.staleMs, 3 * 3600000);
  assert.match(s.note, /12h kWh interval/);
});

test('kwhSnapshot: a fresh reading carries no warning note', () => {
  const s = buildSnapshot({
    device: 'RHW01',
    latest: { value: 49.6, ts: AT_2200_PHT - 60000 },
    now: AT_2200_PHT,
  });
  assert.equal(s.staleMs, 60000);
  assert.equal(s.note, null);
});

test('kwhSnapshot: consumption is the rise since yesterday', () => {
  const s = buildSnapshot({
    device: 'RHW01',
    latest: { value: 50.0, ts: AT_2200_PHT },
    previous: { value: 49.6 },
    now: AT_2200_PHT,
  });
  assert.ok(Math.abs(s.deltaKwh - 0.4) < 1e-9);
  assert.equal(s.resetSuspected, false);
});

test('kwhSnapshot: a meter that went BACKWARDS is a reset, not negative usage', () => {
  // wecon2 does exactly this on every reboot: 1512.97 -> 1500.
  const s = buildSnapshot({
    device: 'wecon2',
    latest: { value: 1500, ts: AT_2200_PHT },
    previous: { value: 1512.97 },
    now: AT_2200_PHT,
  });
  assert.equal(s.resetSuspected, true);
  assert.equal(s.deltaKwh, null, 'negative consumption must never be reported');
});

test('kwhSnapshot: no reading at all is recorded honestly, not as zero', () => {
  const s = buildSnapshot({ device: 'RHW01', latest: null, now: AT_2200_PHT });
  assert.equal(s.value, null);
  assert.notEqual(s.value, 0, 'a missing meter reading must not look like no consumption');
  assert.equal(s.dateKey, '2026-09-19');
  assert.match(s.note, /no kWh reading/);
});

test('kwhSnapshot: a reading with no timestamp reports unknown staleness', () => {
  const s = buildSnapshot({
    device: 'RHW01',
    latest: { value: 49.6 },        // no ts
    now: AT_2200_PHT,
  });
  assert.equal(s.value, 49.6);
  assert.equal(s.staleMs, null, 'unknown staleness must not be reported as fresh');
});

// --- archiveFormat: day-grouped storage ---------------------------------
//
// This decides how real meter history is stored and read back, so the
// properties under test are the ones that would corrupt it silently:
// parallel arrays staying in step, gaps surviving, and the OLD format
// still being readable while a migration is in flight.

const AF = require('./archiveFormat');

const DAY = AF.dayOf(Date.parse('2026-09-21T13:45:00Z'));
const row = (i, v = 1) => ({ t: DAY + i * 60000, min: v, avg: v + 0.1, max: v + 0.2, n: 60 });

test('archiveFormat: a full day round-trips exactly', () => {
  const rows = Array.from({ length: 1440 }, (_, i) => row(i, i / 100));
  const back = AF.unpackDay(AF.packDay({ device: 'd', tag: 'Current', day: DAY, rows }));
  assert.equal(back.length, 1440);
  assert.deepEqual(back[0], rows[0]);
  assert.deepEqual(back[1439], rows[1439]);
});

test('archiveFormat: gaps survive - a missing minute stays missing', () => {
  // An outage leaves holes. Storing them as present-but-zero would invent
  // readings that never happened.
  const rows = [row(0), row(1), row(500), row(1439)];
  const packed = AF.packDay({ device: 'd', tag: 'Current', day: DAY, rows });
  assert.deepEqual(packed.m, [0, 1, 500, 1439]);
  const back = AF.unpackDay(packed);
  assert.equal(back.length, 4);
  assert.equal(back[2].t, DAY + 500 * 60000);
});

test('archiveFormat: rows arriving out of order are sorted, not mangled', () => {
  const rows = [row(5, 5), row(1, 1), row(3, 3)];
  const back = AF.unpackDay(AF.packDay({ device: 'd', tag: 'Current', day: DAY, rows }));
  assert.deepEqual(back.map((r) => r.t), [DAY + 60000, DAY + 3 * 60000, DAY + 5 * 60000]);
  assert.equal(back[0].min, 1);
  assert.equal(back[2].min, 5);
});

test('archiveFormat: two rollups in one minute cannot desync the arrays', () => {
  const rows = [row(0, 1), { ...row(0, 99) }, row(1, 2)];
  const packed = AF.packDay({ device: 'd', tag: 'Current', day: DAY, rows });
  assert.equal(packed.m.length, packed.min.length);
  assert.equal(packed.m.length, packed.avg.length);
  assert.equal(packed.m.length, packed.max.length);
  assert.equal(packed.m.length, packed.n.length);
  assert.deepEqual(packed.m, [0, 1]);
});

test('archiveFormat: rows outside the day are refused, not silently folded in', () => {
  const rows = [row(0), { ...row(0), t: DAY - 60000 }, { ...row(0), t: DAY + AF.DAY_MS }];
  const packed = AF.packDay({ device: 'd', tag: 'Current', day: DAY, rows });
  assert.equal(packed.m.length, 1, 'a neighbouring day leaked into this document');
});

test('archiveFormat: an empty day returns null, not an empty document', () => {
  // "No data" and "never archived" must stay distinguishable.
  assert.equal(AF.packDay({ device: 'd', tag: 'Current', day: DAY, rows: [] }), null);
  assert.equal(AF.packDay({ device: 'd', tag: 'Current', day: DAY, rows: null }), null);
});

test('archiveFormat: malformed rows are dropped rather than stored as nulls', () => {
  const rows = [row(0), { t: DAY + 60000, min: 'x', avg: 1, max: 2, n: 3 }, row(2)];
  const packed = AF.packDay({ device: 'd', tag: 'Current', day: DAY, rows });
  assert.deepEqual(packed.m, [0, 2]);
});

test('archiveFormat: the OLD hourly format is still readable', () => {
  // Both shapes exist while a migration is running. A reader that only
  // understands the new one turns a format change into an outage.
  const v1 = { samples: [{ t: DAY, min: 1, avg: 2, max: 3, n: 60 }] };
  const back = AF.unpackDay(v1);
  assert.equal(back.length, 1);
  assert.equal(back[0].t, DAY);
  assert.equal(back[0].avg, 2);
});

test('archiveFormat: day ids cover the whole requested span', () => {
  const ids = AF.dayIdsFor('Current', DAY - 6 * AF.DAY_MS, DAY);
  assert.equal(ids.length, 7, '7 days must be 7 documents');
  assert.match(ids[6], /^Current_\d{4}-\d{2}-\d{2}$/);
  // a range inside one day is one document, not zero
  assert.equal(AF.dayIdsFor('Current', DAY + 1000, DAY + 2000).length, 1);
});

// ---------------------------------------------------------------------------
//  deviceRegistry + mallOverview
// ---------------------------------------------------------------------------
const DR = require('./deviceRegistry');
const MO = require('./mallOverview');

const MALL = {
  'tenant-a': { devices: { 'ayala-c01': true }, members: { ua: 'viewer' } },
  'tenant-b': { devices: { 'ayala-c02': true }, members: { ub: 'viewer' } },
  'ayala-mgmt': { devices: { 'ayala-c01': true, 'ayala-c02': true }, members: { m: 'viewer' } },
};

test('deviceRegistry: device list comes from companies, not a hardcoded array', () => {
  assert.deepEqual(DR.listDevices({ companies: MALL }), ['ayala-c01', 'ayala-c02']);
});

test('deviceRegistry: a device in NO company is still swept via the seed', () => {
  // The real case: a box commissioned and publishing before anyone set up
  // its company. Dropping it from the sweeps is the silent gap this closes.
  const ids = DR.listDevices({ companies: MALL, seed: ['RHW01'] });
  assert.ok(ids.includes('RHW01'), 'seeded device was dropped');
  assert.equal(ids.length, 3);
});

test('deviceRegistry: a device in two companies is listed once', () => {
  const ids = DR.listDevices({ companies: MALL, seed: ['ayala-c01'] });
  assert.equal(ids.filter((d) => d === 'ayala-c01').length, 1);
});

test('deviceRegistry: tenant + mall both own the device (the "do both" model)', () => {
  const by = DR.companiesByDevice(MALL);
  assert.deepEqual(by['ayala-c01'], ['ayala-mgmt', 'tenant-a']);
  assert.deepEqual(by['ayala-c02'], ['ayala-mgmt', 'tenant-b']);
});

test('deviceRegistry: only multi-device companies get an overview', () => {
  // No flag to set and none to forget: holding more than one device IS the
  // landlord case.
  assert.deepEqual(DR.overviewCompanies(MALL), ['ayala-mgmt']);
});

test('mallOverview: worst tag state wins, because the question is "needs attention"', () => {
  const r = MO.tenantRow({
    deviceId: 'd', name: 'Toy Shop', now: 1000,
    latest: { Current: { value: 3.4 }, Voltage: { value: 230 } },
    status: { lastSeen: 1000 },
    tagState: { Current: 'ok', Voltage: 'high' },
    offline: false,
  });
  assert.equal(r.alarm, 'high');
  assert.equal(r.name, 'Toy Shop');
  assert.deepEqual(r.values, { Current: { v: 3.4 }, Voltage: { v: 230 } });
});

test('mallOverview: offline outranks an alarm', () => {
  // A tenant that stopped reporting while over its threshold is an OFFLINE
  // problem. Showing "high" would imply the reading is current.
  const r = MO.tenantRow({
    deviceId: 'd', now: 1000, latest: {}, status: { lastSeen: 1000 },
    tagState: { Current: 'high' }, offline: true,
  });
  assert.equal(r.alarm, 'offline');
  assert.equal(r.online, false);
});

test('mallOverview: a tenant the engine never evaluated is not assumed fine', () => {
  const never = MO.tenantRow({
    deviceId: 'd', now: 10 * 60000, latest: {}, status: {}, offline: null,
  });
  assert.equal(never.alarm, 'offline', 'no lastSeen must not read as healthy');

  const fresh = MO.tenantRow({
    deviceId: 'd', now: 10 * 60000, latest: {},
    status: { lastSeen: 10 * 60000 - 1000 }, offline: null,
  });
  assert.equal(fresh.alarm, 'ok');
});

test('mallOverview: a dial arrives with its own thresholds, no extra read', () => {
  // The whole point of the projection: ninety dials, one subscription.
  const r = MO.tenantRow({
    deviceId: 'd', now: 1000, status: { lastSeen: 1000 }, offline: false,
    latest: { Current: { value: 6.7 } },
    rules: { Current: { hi: 32 } },
  });
  assert.equal(r.values.Current.hi, 32);
  // No range shipped when a threshold already sets the scale - those bytes
  // would be re-read by every viewer for nothing.
  assert.equal(r.values.Current.rmin, undefined);
});

test('mallOverview: an unruled tag ships the range it was SEEN in', () => {
  // Rollups carry the instantaneous extremes. Using them is what keeps a
  // live needle on the dial; a band from the spread of the AVERAGES is far
  // too narrow and pins the needle off the end.
  const windows = Array.from({ length: 12 }, (_, i) => ({
    minute: i, byTag: { Current: { min: 1.2, avg: 3.4 + (i % 2) * 0.1, max: 9.6 } },
  }));
  const r = MO.tenantRow({
    deviceId: 'd', now: 1000, status: { lastSeen: 1000 }, offline: false,
    latest: { Current: { value: 9.5 } }, rules: {}, windows,
  });
  assert.ok(r.values.Current.rmin < 1.2, 'range must be padded below the seen min');
  assert.ok(r.values.Current.rmax > 9.6, 'range must be padded above the seen max');
  // The live reading has to land INSIDE the dial, which was the whole bug.
  assert.ok(r.values.Current.rmin < 9.5 && 9.5 < r.values.Current.rmax);
});

test('mallOverview: a dead-constant tag still gets a dial with width', () => {
  const windows = Array.from({ length: 10 }, (_, i) => ({
    minute: i, byTag: { Current: { min: 5, avg: 5, max: 5 } },
  }));
  const r = MO.tenantRow({
    deviceId: 'd', now: 1000, status: { lastSeen: 1000 }, offline: false,
    latest: { Current: { value: 5 } }, rules: {}, windows,
  });
  assert.ok(r.values.Current.rmax > r.values.Current.rmin, 'collapsed to a point');
});

test('mallOverview: no rollups means no range, not a fabricated one', () => {
  const r = MO.tenantRow({
    deviceId: 'd', now: 1000, status: { lastSeen: 1000 }, offline: false,
    latest: { Current: { value: 3.4 } }, rules: {}, windows: [],
  });
  assert.equal(r.values.Current.rmin, undefined);
  assert.equal(r.values.Current.v, 3.4, 'the reading itself must still be there');
});

test('mallOverview: a missing reading is absent, never written as null', () => {
  const r = MO.tenantRow({
    deviceId: 'd', now: 1000, status: { lastSeen: 1000 }, offline: false,
    latest: { Current: { value: 3.4 }, Voltage: {}, kWh: { value: null } },
  });
  assert.deepEqual(Object.keys(r.values), ['Current']);
});

test('mallOverview: totals count units, and say how many kWh figures they cover', () => {
  const rows = {
    a: { alarm: 'ok', online: true, kwh: { deltaKwh: 12.5 } },
    b: { alarm: 'high', online: true, kwh: { deltaKwh: 4.25 } },
    c: { alarm: 'offline', online: false },
    d: { alarm: 'low', online: true, kwh: { deltaKwh: null } },
  };
  const t = MO.rollUp(rows);
  assert.equal(t.tenants, 4);
  assert.equal(t.inAlarm, 2);
  assert.equal(t.offline, 1);
  assert.equal(t.kwhToday, 16.75);
  // 4 tenants but only 2 known readings - the total must not pretend to
  // cover the other two.
  assert.equal(t.kwhFrom, 2);
});

test('mallOverview: no kWh known at all reports null, not a confident zero', () => {
  const t = MO.rollUp({ a: { alarm: 'ok', online: true } });
  assert.equal(t.kwhToday, null);
  assert.equal(t.kwhFrom, 0);
});

// ---------------------------------------------------------------------------
//  alertQuery - filtering and paging for the alert log
// ---------------------------------------------------------------------------
const AQ = require('./alertQuery');

// A fake log in Firestore's own total order: ts descending, then path.
function fakeLog(rows) {
  const docs = rows.map((r, i) => ({
    id: `a${i}`,
    path: `devices/${r.device}/alerts/a${String(i).padStart(4, '0')}`,
    ts: r.ts,
    data: { ts: r.ts, device: r.device, kind: r.kind || 'spike', tagKey: r.tagKey === undefined ? 'Current' : r.tagKey },
  }));
  docs.sort((a, b) => (b.ts - a.ts) || (a.path < b.path ? 1 : -1));
  const fetchPage = async (after, n) => {
    const from = after ? docs.indexOf(after) + 1 : 0;
    const page = docs.slice(from, from + n);
    return { docs: page, exhausted: from + n >= docs.length };
  };
  return { docs, fetchPage };
}

async function drain(log, filters, { maxScan = 1500, batch = 300 } = {}) {
  const seen = [];
  let after = null;
  for (let guard = 0; guard < 200; guard++) {
    const r = await AQ.runFiltered({ fetchPage: log.fetchPage, afterDoc: after, filters, maxScan, batch });
    seen.push(...r.alerts);
    if (!r.hasMore) break;
    after = r.last;
  }
  return seen;
}

test('alertQuery: alerts sharing a timestamp are never skipped at a page edge', async () => {
  // THE BUG THIS REPLACES. Paging continued from `ts < before`, and tenants
  // share minute timestamps constantly - six devices spiking together write
  // six alerts at the identical ts. A page ending inside that minute lost
  // the rest of it for good.
  const rows = [];
  for (let m = 0; m < 5; m++) {
    for (const d of ['wecon2', 'wecon2-c2', 'wecon2-c3', 'wecon3', 'wecon3-c2', 'wecon3-c3']) {
      rows.push({ ts: 1_000_000 - m * 60000, device: d });
    }
  }
  const log = fakeLog(rows);
  const f = AQ.parseFilters({ limit: '4' });   // 4 does not divide 6: edges land mid-minute
  const got = await drain(log, f, { batch: 3 });
  assert.equal(got.length, rows.length, `returned ${got.length} of ${rows.length}`);
  assert.equal(new Set(got.map((a) => a.id)).size, rows.length, 'an alert came back twice');
});

test('alertQuery: a tenant filter finds that tenant deep in the log, not just page one', async () => {
  // Filtering the page already in hand would show one tenant's alerts from
  // among the latest 200 mall-wide and look complete. It is not.
  const rows = [];
  for (let i = 0; i < 600; i++) rows.push({ ts: 5_000_000 - i * 1000, device: 'busy' });
  rows.push({ ts: 1_000, device: 'quiet' });            // the oldest thing in the log
  const log = fakeLog(rows);
  const got = await drain(log, AQ.parseFilters({ devices: 'quiet' }));
  assert.equal(got.length, 1);
  assert.equal(got[0].device, 'quiet');
});

test('alertQuery: a scan that runs out of budget says so and can resume', async () => {
  const rows = [];
  for (let i = 0; i < 1000; i++) rows.push({ ts: 9_000_000 - i * 1000, device: 'busy' });
  rows.push({ ts: 10, device: 'rare' });
  const log = fakeLog(rows);
  const f = AQ.parseFilters({ devices: 'rare' });
  const first = await AQ.runFiltered({ fetchPage: log.fetchPage, filters: f, maxScan: 400 });
  assert.equal(first.alerts.length, 0);
  assert.equal(first.partial, true, 'must admit it stopped early');
  assert.equal(first.hasMore, true);
  assert.equal(first.scanned, 400);
  // ...and carrying on from where it stopped reaches the match.
  const all = await drain(log, f, { maxScan: 400 });
  assert.equal(all.length, 1);
});

test('alertQuery: an exhausted log reports no more pages', async () => {
  const log = fakeLog([{ ts: 3, device: 'a' }, { ts: 2, device: 'a' }]);
  const r = await AQ.runFiltered({ fetchPage: log.fetchPage, filters: AQ.parseFilters({}) });
  assert.equal(r.alerts.length, 2);
  assert.equal(r.hasMore, false);
  assert.equal(r.partial, false);
});

test('alertQuery: kind, reading and time filters combine', async () => {
  const log = fakeLog([
    { ts: 500, device: 'a', kind: 'alarm-high', tagKey: 'Current' },
    { ts: 400, device: 'a', kind: 'spike', tagKey: 'Current' },
    { ts: 300, device: 'a', kind: 'alarm-high', tagKey: 'Voltage' },
    { ts: 200, device: 'a', kind: 'offline', tagKey: null },
    { ts: 100, device: 'a', kind: 'alarm-high', tagKey: 'Current' },
  ]);
  const got = await drain(log, AQ.parseFilters({
    kinds: 'alarm-high', tags: 'Current', since: '150', until: '600',
  }));
  assert.deepEqual(got.map((a) => a.ts), [500]);
});

test('alertQuery: a reading filter excludes device-level alerts', async () => {
  // Narrowing to "Voltage" is a question about voltage. A box going offline
  // carries no tag and is not the answer to it.
  const log = fakeLog([{ ts: 2, device: 'a', kind: 'offline', tagKey: null }]);
  const got = await drain(log, AQ.parseFilters({ tags: 'Voltage' }));
  assert.equal(got.length, 0);
});

test('alertQuery: an inverted range drops the upper bound instead of returning nothing', () => {
  // An empty log reads as a quiet site. A typo in a date picker must not
  // produce that.
  const f = AQ.parseFilters({ since: '500', until: '100' });
  assert.equal(f.since, 500);
  assert.equal(f.until, null);
});

test('alertQuery: list parameters are bounded and de-duplicated', () => {
  assert.deepEqual(AQ.list('a, b,a,,c'), ['a', 'b', 'c']);
  assert.equal(AQ.list(Array.from({ length: 300 }, (_, i) => `d${i}`).join(',')).length, 100);
  assert.deepEqual(AQ.list(undefined), []);
});

// ---------------------------------------------------------------------------
//  billing - money, so the properties are pinned down hard
// ---------------------------------------------------------------------------
const BL = require('./billing');
const BE = require('./billEmail');

const PH22 = (d) => BL.readingTimeOf(d);   // 22:00 PHT on a date

test('billing: 22:00 PHT is 14:00 UTC on the same calendar date', () => {
  assert.equal(new Date(PH22('2026-09-30')).toISOString(), '2026-09-30T14:00:00.000Z');
});

test('billing: impossible dates are rejected, not rolled into next month', () => {
  // Date.UTC(2026, 1, 30) quietly becomes 2 March. A bill for "30 February"
  // must be refused, not issued for a different day.
  assert.equal(BL.readingTimeOf('2026-02-30'), null);
  assert.equal(BL.readingTimeOf('2026-13-01'), null);
  assert.equal(BL.readingTimeOf('garbage'), null);
});

test('billing: a period runs meter read to meter read', () => {
  // 1-30 Sep = from the 22:00 reading on 31 Aug to the 22:00 reading on 30 Sep.
  const p = BL.periodBoundaries('2026-09-01', '2026-09-30', Date.parse('2026-10-05T00:00:00Z'));
  assert.equal(new Date(p.startTs).toISOString(), '2026-08-31T14:00:00.000Z');
  assert.equal(new Date(p.endTs).toISOString(), '2026-09-30T14:00:00.000Z');
  assert.equal(p.days, 30);
});

test('billing: consecutive periods neither overlap nor leave a gap', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  const sep = BL.periodBoundaries('2026-09-01', '2026-09-30', now);
  const oct = BL.periodBoundaries('2026-10-01', '2026-10-31', now);
  assert.equal(oct.startTs, sep.endTs, 'October must start at the exact reading September ended on');
});

test('billing: a period whose closing reading has not been taken is refused', () => {
  // It would otherwise stop at whatever the latest reading was and look complete.
  const beforeReading = Date.parse('2026-09-30T13:59:00Z');
  const p = BL.periodBoundaries('2026-09-01', '2026-09-30', beforeReading);
  assert.ok(p.error && /not happened yet/.test(p.error));
});

test('billing: a backwards period is refused', () => {
  assert.ok(BL.periodBoundaries('2026-09-30', '2026-09-01').error);
});

const daily = (from, values) => values.map((v, i) => ({ ts: PH22(from) + i * BL.DAY_MS, value: v }));

test('billing: consumption is the rise between readings', () => {
  const readings = daily('2026-08-31', [1000, 1010, 1025, 1040]);   // 31 Aug .. 3 Sep
  const c = BL.consumption(readings, PH22('2026-08-31'), PH22('2026-09-03'));
  assert.equal(c.kwh, 40);
  assert.deepEqual(c.flags, []);
});

test('billing: a meter reset is flagged, never billed as negative or absurd', () => {
  // The simulated boxes reset on reboot; a real meter resets when replaced.
  // End minus start here would be -485.
  const readings = daily('2026-08-31', [1500, 1510, 1520, 1025, 1035]);
  const c = BL.consumption(readings, PH22('2026-08-31'), PH22('2026-09-04'));
  assert.equal(c.kwh, 30, 'only the rises count');
  assert.equal(c.resets, 1);
  assert.ok(c.flags.includes('meter-reset'));
});

test('billing: a late reading after a box was offline at 22:00 is used and flagged', () => {
  // The box takes the day's reading on its first cycle after coming back.
  const start = PH22('2026-08-31');
  const readings = [
    { ts: start + 5 * BL.HOUR_MS, value: 1000 },      // 03:00, five hours late
    { ts: PH22('2026-09-01'), value: 1012 },
  ];
  const c = BL.consumption(readings, start, PH22('2026-09-01'));
  assert.equal(c.kwh, 12);
  assert.ok(c.flags.includes('start-reading-off'), 'an off-boundary reading must say so');
});

test('billing: no readings at all gives no figure, not zero', () => {
  // Zero would be a bill for nothing that looks correct.
  const c = BL.consumption([], PH22('2026-08-31'), PH22('2026-09-30'));
  assert.equal(c.kwh, null);
  assert.ok(c.flags.includes('no-readings'));
});

test('billing: amounts are exact to the centavo', () => {
  // 0.1 + 0.2 must never reach a bill.
  const a = BL.amounts({ kwh: 123.456, ratePerKwh: 12.35, vatPct: 12, fixedCharge: 50.10 });
  assert.equal(a.energy, 1524.68);       // 123.456 x 12.35 = 1524.6816
  assert.equal(a.fixed, 50.1);
  assert.equal(a.subtotal, 1574.78);
  assert.equal(a.vat, 188.97);           // 12% of 1574.78 = 188.9736
  assert.equal(a.total, 1763.75);
});

test('billing: emails are split, lowercased, de-duplicated, and bad ones reported', () => {
  const r = BL.parseEmails('Shop@Toys.ph, shop@toys.ph; owner@toys.ph  not-an-email');
  assert.deepEqual(r.valid, ['shop@toys.ph', 'owner@toys.ph']);
  assert.deepEqual(r.invalid, ['not-an-email']);
});

test('billing: a sender name cannot inject email headers', () => {
  assert.equal(BL.cleanName('Mall\r\nBcc: victim@x.com'), 'MallBcc: victim@x.com');
  assert.equal(BL.cleanName('Evil <x@y.com>'), 'Evil x@y.com');
});

test('billing: no rate means no bills, rather than bills for zero', () => {
  assert.ok(BL.readSettings({}).error);
  assert.ok(BL.readSettings({ ratePerKwh: 0 }).error);
  assert.equal(BL.readSettings({ ratePerKwh: 12.5 }).settings.ratePerKwh, 12.5);
});

test('billing: a draft carries everything needed to reproduce it', () => {
  const settings = BL.readSettings({ ratePerKwh: 10, vatPct: 12 }).settings;
  const period = BL.periodBoundaries('2026-09-01', '2026-09-02', Date.parse('2026-10-01T00:00:00Z'));
  const b = BL.draftBill({
    deviceId: 'wecon2-c2', tenantName: 'Toy Shop', emails: 'a@toys.ph',
    readings: daily('2026-08-31', [100, 110, 125]), period, settings,
  });
  assert.equal(b.kwh, 25);
  assert.equal(b.rate, 10);
  assert.equal(b.total, 280);            // 250 + 12%
  assert.equal(b.start.value, 100);
  assert.equal(b.end.value, 125);
  assert.equal(b.included, true);
});

test('billing: a manual adjustment replaces the measured figure but keeps it', () => {
  const settings = BL.readSettings({ ratePerKwh: 10 }).settings;
  const period = BL.periodBoundaries('2026-09-01', '2026-09-02', Date.parse('2026-10-01T00:00:00Z'));
  const b = BL.draftBill({
    deviceId: 'd', tenantName: 'T', emails: 'a@b.ph',
    readings: daily('2026-08-31', [1500, 1510, 20]), period, settings,
    keep: { adjustKwh: 40, adjustNote: 'meter replaced 2 Sep' },
  });
  assert.equal(b.kwh, 40);
  assert.equal(b.measuredKwh, 10, 'the measured figure must survive for the audit trail');
  assert.equal(b.total, 400);
});

test('billing: a bill with no kWh or no email cannot be sent', () => {
  assert.equal(BL.sendBlocker({ included: true, kwh: null, to: ['a@b.ph'] }), 'no kWh figure');
  assert.equal(BL.sendBlocker({ included: true, kwh: 5, to: [] }), 'no email address');
  assert.equal(BL.sendBlocker({ included: false, kwh: 5, to: ['a@b.ph'] }), 'left out of this run');
  assert.equal(BL.sendBlocker({ status: 'sent', included: true, kwh: 5, to: ['a@b.ph'] }), 'already sent');
  assert.equal(BL.sendBlocker({ included: true, kwh: 5, to: ['a@b.ph'] }), null);
});

test('billEmail: a tenant name with markup arrives as text', () => {
  const settings = BL.readSettings({ ratePerKwh: 10 }).settings;
  const period = BL.periodBoundaries('2026-09-01', '2026-09-02', Date.parse('2026-10-01T00:00:00Z'));
  const bill = BL.draftBill({
    deviceId: 'd', tenantName: '<img src=x onerror=alert(1)>', emails: 'a@b.ph',
    readings: daily('2026-08-31', [1, 2, 3]), period, settings,
  });
  const { html } = BE.buildBillEmail({
    bill, run: { periodFrom: '2026-09-01', periodTo: '2026-09-02' },
    company: { senderName: 'Mall', footer: '<script>x</script>' },
  });
  assert.ok(!html.includes('<img src=x'), 'tenant name was not escaped');
  assert.ok(!html.includes('<script>x'), 'footer was not escaped');
});

test('billEmail: the amount due and period are in both html and text', () => {
  const settings = BL.readSettings({ ratePerKwh: 12.5, vatPct: 12 }).settings;
  const period = BL.periodBoundaries('2026-09-01', '2026-09-30', Date.parse('2026-10-05T00:00:00Z'));
  const bill = BL.draftBill({
    deviceId: 'd', tenantName: 'Toy Shop', emails: 'a@b.ph',
    readings: [{ ts: period.startTs, value: 1000 }, { ts: period.endTs, value: 1100 }],
    period, settings,
  });
  const run = { periodFrom: '2026-09-01', periodTo: '2026-09-30' };
  const out = BE.buildBillEmail({ bill, run, company: { senderName: 'Demo Mall', replyTo: 'm@mall.ph' } });
  // 100 kWh x 12.50 = 1250, + 12% = 1400
  assert.ok(out.html.includes('1,400.00'), 'amount missing from html');
  assert.ok(out.text.includes('1,400.00'), 'amount missing from text');
  assert.ok(out.subject.includes('1 Sep 2026') && out.subject.includes('30 Sep 2026'));
});

// ---------------------------------------------------------------------------
//  billingHandlers - against in-memory fakes of RTDB, Firestore and Resend.
//  The property that matters most: no bill is ever emailed twice.
// ---------------------------------------------------------------------------
const BH = require('./billingHandlers');

function fakeRtdb(tree) {
  const at = (path) => path.split('/').filter(Boolean).reduce((n, k) => (n == null ? undefined : n[k]), tree);
  const snap = (v) => ({ val: () => (v === undefined ? null : v), exists: () => v !== undefined && v !== null });
  const ref = (path) => {
    const q = { lo: null, hi: null };
    const api = {
      orderByKey: () => api,
      startAt: (v) => { q.lo = v; return api; },
      endAt: (v) => { q.hi = v; return api; },
      once: async () => {
        let v = at(path);
        if (v && typeof v === 'object' && (q.lo || q.hi)) {
          v = Object.fromEntries(Object.entries(v).filter(([k]) => (!q.lo || k >= q.lo) && (!q.hi || k <= q.hi)));
        }
        return snap(v);
      },
    };
    return api;
  };
  return { ref };
}

const TS = { toMillis: () => Date.now() };
const FV = { serverTimestamp: () => TS };

function fakeFirestore() {
  const docs = new Map();   // path -> data
  const docRef = (path) => ({
    path,
    id: path.split('/').pop(),
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path), get: (f) => docs.get(path)?.[f] }),
    set: async (d, o) => { docs.set(path, o && o.merge ? { ...(docs.get(path) || {}), ...d } : { ...d }); },
    update: async (d) => { docs.set(path, { ...(docs.get(path) || {}), ...d }); },
    delete: async () => { docs.delete(path); },
    collection: (name) => colRef(`${path}/${name}`),
  });
  const colRef = (path) => {
    const list = () => [...docs.keys()]
      .filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/'))
      .map((k) => ({ id: k.split('/').pop(), data: () => docs.get(k) }));
    const api = {
      doc: (id) => docRef(`${path}/${id}`),
      get: async () => ({ docs: list() }),
      orderBy: () => api,
      limit: () => api,
    };
    return api;
  };
  const fs = {
    collection: (name) => colRef(name),
    doc: (p) => docRef(p),
    batch: () => {
      const ops = [];
      return {
        set: (ref, d, o) => ops.push(() => ref.set(d, o)),
        delete: (ref) => ops.push(() => ref.delete()),
        commit: async () => { for (const op of ops) await op(); },
      };
    },
    runTransaction: async (fn) => fn({
      get: (ref) => ref.get(),
      update: (ref, d) => ref.update(d),
    }),
  };
  return { fs, docs };
}

function fakeRes() {
  const r = { code: 200, body: null, headers: {} };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}

const OPERATOR = 'op-uid';
const VIEWER = 'viewer-uid';
const auth = () => ({ verifyIdToken: async (t) => ({ uid: t, email: `${t}@x.ph`, firebase: {} }) });

// Two tenants with daily 22:00 readings across 1-3 Sep; the second has no email.
const START = Date.parse('2026-08-31T14:00:00Z');
const raw = (base, step) => Object.fromEntries([0, 1, 2, 3].map((i) => [String(START + i * 86400000), base + i * step]));

function world({ secondEmail = '' } = {}) {
  const rtdb = fakeRtdb({
    admins: {},
    companyMembers: { mall: { [OPERATOR]: 'operator', [VIEWER]: 'viewer' } },
    companies: { mall: { name: 'Demo Mall', devices: { t1: true, t2: true } } },
    companyBilling: { mall: {
      ratePerKwh: 10, vatPct: 12, replyTo: 'billing@mall.ph', senderName: 'Demo Mall',
      tenants: { t1: { billingName: 'Toy Shop', emails: 'toys@shop.ph' }, t2: { billingName: 'Cafe', emails: secondEmail } },
    } },
    naming: {},
    devices: {
      t1: { tags: { kWh: {} }, history: { kWh: { raw: raw(1000, 10) } } },
      t2: { tags: { kWh: {} }, history: { kWh: { raw: raw(500, 5) } } },
    },
  });
  const { fs, docs } = fakeFirestore();
  const deps = { getDatabase: () => rtdb, getFirestore: () => fs, getAuth: auth, FieldValue: FV };
  const api = BH.createBillingApi(deps);
  const call = async (uid, body) => {
    const res = fakeRes();
    await api({ method: 'POST', headers: { 'x-id-token': uid }, body, query: {} }, res);
    return res;
  };
  return { deps, docs, call };
}

function fakeResend(behaviour = () => ({ ok: true })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ key: init.headers['Idempotency-Key'], to: body.to, cc: body.cc, from: body.from });
    const b = behaviour(calls.length);
    if (b.throw) throw new Error('network down');
    return b.ok
      ? { ok: true, status: 200, json: async () => ({ id: `msg_${calls.length}` }) }
      : { ok: false, status: 422, json: async () => ({ message: b.message || 'invalid' }) };
  };
  return { calls, fetchImpl };
}

async function send(w, uid, resend, extra = {}) {
  const handler = BH.createBillingSend({
    ...w.deps, apiKey: () => 'k', fromAddress: 'billing@instrubytemonitoring.com', fetchImpl: resend.fetchImpl,
  });
  const res = fakeRes();
  await handler({ method: 'POST', headers: { 'x-id-token': uid }, body: { action: 'send', company: 'mall', run: RUN, ...extra }, query: {} }, res);
  return res;
}

const RUN = '2026-09-01_2026-09-03';
const PREP = { action: 'prepare', company: 'mall', from: '2026-09-01', to: '2026-09-03' };

test('billingApi: prepare builds one bill per tenant from the raw readings', async () => {
  const w = world({ secondEmail: 'cafe@shop.ph' });
  const res = await w.call(OPERATOR, PREP);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const t1 = res.body.bills.find((b) => b.deviceId === 't1');
  assert.equal(t1.kwh, 30);                 // 1000 -> 1030
  assert.equal(t1.total, 336);              // 300 + 12%
  assert.deepEqual(t1.to, ['toys@shop.ph']);
  assert.equal(res.body.run.summary.included, 2);
});

test('billingApi: a viewer cannot prepare bills', async () => {
  const w = world();
  const res = await w.call(VIEWER, PREP);
  assert.equal(res.code, 403);
});

test('billingApi: a company id cannot steer the path', async () => {
  const w = world();
  const res = await w.call(OPERATOR, { ...PREP, company: 'mall/../admins' });
  assert.equal(res.code, 400);
});

test('billingApi: refreshing a run keeps the decisions already made on it', async () => {
  const w = world({ secondEmail: 'cafe@shop.ph' });
  await w.call(OPERATOR, PREP);
  await w.call(OPERATOR, { action: 'update', company: 'mall', run: RUN, device: 't2', included: false });
  await w.call(OPERATOR, { action: 'update', company: 'mall', run: RUN, device: 't1', adjustKwh: 42, adjustNote: 'meter swapped' });
  const again = await w.call(OPERATOR, PREP);
  const t1 = again.body.bills.find((b) => b.deviceId === 't1');
  const t2 = again.body.bills.find((b) => b.deviceId === 't2');
  assert.equal(t2.included, false, 'an exclusion was lost on refresh');
  assert.equal(t1.kwh, 42, 'an adjustment was lost on refresh');
  assert.equal(t1.measuredKwh, 30);
});

test('billingApi: an adjustment must say why', async () => {
  const w = world();
  await w.call(OPERATOR, PREP);
  const res = await w.call(OPERATOR, { action: 'update', company: 'mall', run: RUN, device: 't1', adjustKwh: 42 });
  assert.equal(res.code, 400);
});

test('billingSend: each bill is emailed once, and a second Send sends nothing', async () => {
  const w = world({ secondEmail: 'cafe@shop.ph' });
  await w.call(OPERATOR, PREP);
  const resend = fakeResend();
  const first = await send(w, OPERATOR, resend);
  assert.equal(resend.calls.length, 2);
  assert.equal(first.body.summary.sent, 2);

  const second = await send(w, OPERATOR, resend);
  assert.equal(resend.calls.length, 2, 'a second Send delivered bills again');
  assert.ok(second.body.results.every((r) => r.skipped === 'already sent'));
});

test('billingSend: the mall is Reply-To and CC, and the From is ours', async () => {
  const w = world({ secondEmail: 'cafe@shop.ph' });
  await w.call(OPERATOR, PREP);
  const resend = fakeResend();
  await send(w, OPERATOR, resend);
  assert.deepEqual(resend.calls[0].cc, ['billing@mall.ph']);
  assert.equal(resend.calls[0].from, '"Demo Mall" <billing@instrubytemonitoring.com>');
});

test('billingSend: a bill with no email address is skipped, never sent to nobody', async () => {
  const w = world({ secondEmail: '' });
  await w.call(OPERATOR, PREP);
  const resend = fakeResend();
  const res = await send(w, OPERATOR, resend);
  assert.equal(resend.calls.length, 1);
  assert.equal(res.body.results.find((r) => r.deviceId === 't2').skipped, 'no email address');
});

test('billingSend: a refused email is retried with a NEW idempotency key', async () => {
  // Resend refused it, so no email exists; replaying the old key would just
  // replay the refusal.
  const w = world();
  await w.call(OPERATOR, PREP);
  const failing = fakeResend(() => ({ ok: false, message: 'domain not verified' }));
  const r1 = await send(w, OPERATOR, failing);
  assert.equal(r1.body.results[0].error, 'domain not verified');
  assert.match(failing.calls[0].key, /\/t1\/0$/);

  const ok = fakeResend();
  await send(w, OPERATOR, ok);
  assert.match(ok.calls[0].key, /\/t1\/1$/, 'retry reused the key of a refused attempt');
});

test('billingSend: after a network failure the bill is held, not re-sent at once', async () => {
  // Whether Resend received it is unknown. Sending again immediately could
  // double-bill; it is held, and a later retry reuses the SAME key so Resend
  // deduplicates it if the first one did arrive.
  const w = world();
  await w.call(OPERATOR, PREP);
  const flaky = fakeResend(() => ({ throw: true }));
  await send(w, OPERATOR, flaky);
  const bill = w.docs.get(`billing/mall/runs/${RUN}/bills/t1`);
  assert.equal(bill.status, 'sending');
  assert.equal(bill.attempts, 0, 'the attempt number must not advance on an unknown outcome');

  const again = fakeResend();
  const r = await send(w, OPERATOR, again);
  assert.equal(again.calls.length, 0, 'retried while the outcome was still unknown');
  assert.equal(r.body.results[0].skipped, 'already being sent');
});

test('billingSend: a viewer cannot send', async () => {
  const w = world({ secondEmail: 'cafe@shop.ph' });
  await w.call(OPERATOR, PREP);
  const resend = fakeResend();
  const res = await send(w, VIEWER, resend);
  assert.equal(res.code, 403);
  assert.equal(resend.calls.length, 0);
});

test('billingApi: a sent bill can be neither edited nor discarded', async () => {
  const w = world({ secondEmail: 'cafe@shop.ph' });
  await w.call(OPERATOR, PREP);
  await send(w, OPERATOR, fakeResend());
  const edit = await w.call(OPERATOR, { action: 'update', company: 'mall', run: RUN, device: 't1', included: false });
  assert.equal(edit.code, 409);
  const discard = await w.call(OPERATOR, { action: 'discard', company: 'mall', run: RUN });
  assert.equal(discard.code, 409);
});

test('billingApi: refreshing after a send leaves the sent bill exactly as it went out', async () => {
  const w = world({ secondEmail: 'cafe@shop.ph' });
  await w.call(OPERATOR, PREP);
  await send(w, OPERATOR, fakeResend());
  const before = JSON.stringify(w.docs.get(`billing/mall/runs/${RUN}/bills/t1`));
  await w.call(OPERATOR, PREP);
  assert.equal(JSON.stringify(w.docs.get(`billing/mall/runs/${RUN}/bills/t1`)), before);
});
