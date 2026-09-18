'use strict';

// Server-side alert detection.
//
// WHY THIS IS NOT THE EXISTING CLIENT-SIDE ALERT CODE
//
// src/hooks/useAlertCenter.js computes alerts in the browser and keeps them
// in localStorage. That is a viewer-side notebook, and it has three
// properties that make it unusable as a record:
//
//   1. NOTHING IS RECORDED WHEN NO TAB IS OPEN. An alarm at 03:00 with
//      nobody watching never happened, as far as the log is concerned.
//      This is the one that matters.
//   2. It is per browser. Clearing site data erases it; a colleague on
//      another machine sees a different history.
//   3. It is capped at 300 entries.
//
// This engine runs on a schedule regardless of who is watching, and writes
// to Firestore, so the record is complete, shared and permanent.
//
// IT EVALUATES MINUTE ROLLUPS, NOT THE LIVE VALUE. A rollup carries min and
// max for the whole minute, so a two-second excursion is caught even though
// a once-a-minute poll of latest/ would have missed it entirely. That is
// also why the deadband on the device does not blind this: rollups are
// accumulated from every sample whether or not it was published.

// A device is called offline once its heartbeat is this stale. The device
// pushes status/lastSeen every 10s, so a minute of silence is unambiguous
// rather than a slow cycle.
const DEFAULT_OFFLINE_AFTER_MS = 60000;

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Where one minute of a tag sits against its rule.
 *
 * Uses max for the high test and min for the low test - the extremes of the
 * minute, not its average. An average hides exactly the excursion an alarm
 * exists to catch.
 */
function classify(rollup, rule) {
  if (!rule || (!isNum(rule.hi) && !isNum(rule.lo))) return 'none';
  if (!rollup) return 'unknown';
  if (isNum(rule.hi) && isNum(rollup.max) && rollup.max > rule.hi) return 'high';
  if (isNum(rule.lo) && isNum(rollup.min) && rollup.min < rule.lo) return 'low';
  return 'ok';
}

/**
 * @param device      device id
 * @param windows     [{ minute, byTag: { tagKey: {min,avg,max,n} } }] ascending
 * @param rules       { tagKey: { hi, lo } }
 * @param tagNames    { tagKey: displayName }
 * @param prevState   { tags: { tagKey: 'ok'|'high'|'low' }, offline: bool, lastMinute }
 * @param status      { lastSeen }
 * @param now         epoch ms
 *
 * Returns { events, state }. Events are TRANSITIONS only - a tag that stays
 * above its limit for an hour produces one alert, not sixty. A log that
 * repeats itself every minute is one nobody reads.
 */
function evaluate({
  device,
  windows = [],
  rules = {},
  tagNames = {},
  prevState = {},
  status = {},
  now = Date.now(),
  offlineAfterMs = DEFAULT_OFFLINE_AFTER_MS,
}) {
  const events = [];
  const tagState = { ...(prevState.tags || {}) };
  let lastMinute = prevState.lastMinute || 0;

  const name = (tagKey) => tagNames[tagKey] || tagKey;

  for (const w of windows) {
    if (!w || !isNum(w.minute) || w.minute <= lastMinute) continue;

    for (const [tagKey, rule] of Object.entries(rules)) {
      const rollup = (w.byTag || {})[tagKey];
      const next = classify(rollup, rule);
      if (next === 'none' || next === 'unknown') continue;

      const prev = tagState[tagKey] || 'ok';
      if (next === prev) continue;

      if (next === 'high' || next === 'low') {
        events.push({
          ts: w.minute,
          device,
          kind: next === 'high' ? 'alarm-high' : 'alarm-low',
          level: 'critical',
          tagKey,
          tagName: name(tagKey),
          value: next === 'high' ? rollup.max : rollup.min,
          limit: next === 'high' ? rule.hi : rule.lo,
          message: `${name(tagKey)} ${next === 'high' ? 'above its high limit' : 'below its low limit'}`,
        });
      } else {
        events.push({
          ts: w.minute,
          device,
          kind: 'alarm-clear',
          level: 'info',
          tagKey,
          tagName: name(tagKey),
          value: rollup.avg,
          message: `${name(tagKey)} back within limits`,
        });
      }
      tagState[tagKey] = next;
    }

    lastMinute = w.minute;
  }

  // Device reachability, evaluated against the clock rather than the
  // rollups - a box that has stopped pushing produces no rollups at all, so
  // absence of data is the signal and there is nothing in `windows` to read
  // it from.
  const lastSeen = isNum(status.lastSeen) ? status.lastSeen : null;
  const offlineNow = lastSeen === null ? false : (now - lastSeen) > offlineAfterMs;
  const offlineBefore = Boolean(prevState.offline);

  if (offlineNow && !offlineBefore) {
    events.push({
      ts: lastSeen === null ? now : lastSeen + offlineAfterMs,
      device,
      kind: 'offline',
      level: 'critical',
      tagKey: null,
      tagName: null,
      message: `${device} stopped reporting`,
      lastSeen,
    });
  } else if (!offlineNow && offlineBefore) {
    events.push({
      ts: now,
      device,
      kind: 'online',
      level: 'info',
      tagKey: null,
      tagName: null,
      message: `${device} is reporting again`,
    });
  }

  return {
    events,
    state: { tags: tagState, offline: offlineNow, lastMinute },
  };
}

// Deterministic id, so a re-run over the same window cannot duplicate an
// alert. Firestore .set() on the same id overwrites with identical content
// instead of appending a second copy - the same property the archive relies
// on, and the reason a retry after a partial failure is safe.
function alertId(ev) {
  const tag = ev.tagKey || '_device';
  return `${ev.ts}_${tag}_${ev.kind}`;
}

module.exports = { evaluate, classify, alertId, DEFAULT_OFFLINE_AFTER_MS };
