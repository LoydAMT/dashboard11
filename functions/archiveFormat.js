'use strict';

// How an archived day is stored.
//
// WHAT CHANGED AND WHY
// The first version wrote one document per tag per HOUR, each holding an
// array of {t,min,avg,max,n} maps. Measured on real data, that is ~90 bytes
// per reading - and about 85 of those are the field names and the 13-digit
// timestamp, repeated 1,440 times a day.
//
// Two costs, both of which bite at mall scale rather than at three boxes:
//   - READS. Firestore bills per document. A 7-day chart for one tenant was
//     3 tags x 168 hours = 504 reads. Grouped by day it is 21.
//   - SIZE. Repeating "min","avg","max","n" and a full timestamp on every
//     row is most of the stored bytes.
//
// So: one document per tag per DAY, holding parallel arrays. Field names
// appear once. Timestamps are replaced by a minute index, because the day
// start and the step already say what each slot means.
//
// DELIBERATELY NOT COMPRESSED. A packed binary blob would be ~20x smaller
// again, but it would be opaque in the Firestore console. Readability was
// an explicit requirement, so this keeps plain arrays of numbers that a
// person can scroll through and understand.
//
// UTC DAY BOUNDARIES. The archive is a storage unit, not a business one, so
// it uses UTC and needs no timezone reasoning to locate a record. The kWh
// daily snapshot is the opposite case - it is a billing figure, so it uses
// Philippine days. The two are different on purpose.

const MINUTE_MS = 60000;
const DAY_MS = 86400000;

function dayOf(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

// Document id: {tag}_{YYYY-MM-DD}. Readable at a glance in the console,
// and sorts chronologically, which is what makes "the most recent day" a
// plain orderBy on the id rather than a query.
function dayKey(ms) {
  return new Date(dayOf(ms)).toISOString().slice(0, 10);
}

function docIdFor(tag, ms) {
  return `${tag}_${dayKey(ms)}`;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Pack rows into one day document.
 *
 * @param rows [{ t, min, avg, max, n }] - any order, any subset of the day
 * Returns null when there is nothing worth storing, so a caller can skip
 * writing an empty document rather than create one that means "no data"
 * and one that means "never looked" and be unable to tell them apart.
 */
function packDay({ device, tag, day, rows }) {
  const clean = (rows || [])
    .filter((r) => r && isNum(r.t) && isNum(r.min) && isNum(r.avg) && isNum(r.max))
    .filter((r) => r.t >= day && r.t < day + DAY_MS)
    .sort((a, b) => a.t - b.t);

  if (clean.length === 0) return null;

  const m = [], min = [], avg = [], max = [], n = [];
  let lastIdx = -1;
  for (const r of clean) {
    const idx = Math.floor((r.t - day) / MINUTE_MS);
    // Two rollups landing in the same minute would desynchronise the
    // parallel arrays against `m`. Keep the first and drop the duplicate.
    if (idx === lastIdx) continue;
    lastIdx = idx;
    m.push(idx);
    min.push(r.min);
    avg.push(r.avg);
    max.push(r.max);
    n.push(isNum(r.n) ? r.n : 0);
  }

  return { device, tag, day, step: MINUTE_MS, m, min, avg, max, n, v: 2 };
}

/**
 * Unpack a day document back into the row shape the dashboard already
 * builds from RTDB, so the two merge with no translation step.
 *
 * Tolerates the v1 (hourly, map-per-sample) shape as well, because during a
 * migration both exist and a reader that only understands one of them turns
 * a format change into an outage.
 */
function unpackDay(doc) {
  if (!doc) return [];

  // v1: { samples: [{t,min,avg,max,n}] }
  if (Array.isArray(doc.samples)) {
    return doc.samples
      .filter((s) => s && isNum(s.t))
      .map((s) => ({ t: s.t, min: s.min, avg: s.avg, max: s.max, n: s.n }));
  }

  if (!Array.isArray(doc.m) || !isNum(doc.day)) return [];
  const step = isNum(doc.step) ? doc.step : MINUTE_MS;
  const out = [];
  for (let i = 0; i < doc.m.length; i++) {
    out.push({
      t: doc.day + doc.m[i] * step,
      min: doc.min ? doc.min[i] : undefined,
      avg: doc.avg ? doc.avg[i] : undefined,
      max: doc.max ? doc.max[i] : undefined,
      n: doc.n ? doc.n[i] : undefined,
    });
  }
  return out;
}

/** Every day-document id covering [from, to], for a getAll(). */
function dayIdsFor(tag, from, to) {
  const ids = [];
  for (let d = dayOf(from); d <= dayOf(to); d += DAY_MS) ids.push(docIdFor(tag, d));
  return ids;
}

module.exports = {
  packDay, unpackDay, dayOf, dayKey, docIdFor, dayIdsFor, MINUTE_MS, DAY_MS,
};
