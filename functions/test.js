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
