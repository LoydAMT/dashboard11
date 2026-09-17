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
