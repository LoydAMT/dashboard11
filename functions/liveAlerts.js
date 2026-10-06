'use strict';

// Instant alerts, evaluated the moment a reading is published.
//
// WHY THIS EXISTS ALONGSIDE THE SWEEP
// alertSweep runs every two minutes and evaluates minute summaries. For a
// threshold that is the wrong shape entirely: a reading that goes from 10 to
// 100 should raise its alert when it happens, not when the minute has closed
// and the next sweep has come round. No amount of tightening the schedule
// fixes that - Cloud Scheduler bottoms out at one minute.
//
// A box already publishes a value to devices/{id}/latest/{tag} within about a
// second of it moving past its deadband, and republishes it every ten seconds
// regardless. A database trigger on that path therefore sees every change
// worth knowing about, as it happens, with no change to the box at all. This
// module is the logic that trigger runs; index.js owns the Firebase wiring.
//
// WHAT IT OWNS
// Threshold state for the devices it is switched on for - nothing else may
// evaluate their thresholds, or the two would each record the same crossing.
// The sweep keeps spikes and offline for those devices, and reads the minute
// summaries this module builds as a by-product (see createAccumulator).
//
// Everything here is pure: no Firebase, no clock, no I/O. That is what lets
// the tests drive it through a crossing reading by reading.

const { classify } = require('./alertEngine');

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * One reading against one rule.
 *
 * Events are TRANSITIONS only, exactly as in the sweep's engine: a tag that
 * sits above its threshold for an hour is one alert, not one per reading.
 *
 * @param prev   'ok' | 'high' | 'low' - this tag's state before the reading
 * @param rule   { hi, lo } or null
 * @returns { next, event } - event is null when nothing changed
 */
function thresholdStep({ device, tagKey, tagName, prev = 'ok', value, ts, rule }) {
  const name = tagName || tagKey;
  if (!isNum(value)) return { next: prev, event: null };

  const cls = classify({ min: value, avg: value, max: value }, rule);

  // No rule on this tag (or it was removed). Nothing can be in alarm against
  // a threshold that does not exist, so a leftover 'high' is cleared quietly
  // rather than left to show as an alarm for ever - and without an event,
  // because nothing happened to the reading.
  if (cls === 'none' || cls === 'unknown') return { next: 'ok', event: null };

  if (cls === prev) return { next: prev, event: null };

  if (cls === 'high' || cls === 'low') {
    return {
      next: cls,
      event: {
        ts,
        device,
        kind: cls === 'high' ? 'alarm-high' : 'alarm-low',
        level: 'critical',
        tagKey,
        tagName: name,
        value,
        limit: cls === 'high' ? rule.hi : rule.lo,   // stored key kept for older records
        message: `${name} ${cls === 'high' ? 'above its alert threshold' : 'below its alert threshold'}`,
      },
    };
  }

  return {
    next: 'ok',
    event: {
      ts,
      device,
      kind: 'alarm-clear',
      level: 'info',
      tagKey,
      tagName: name,
      value,
      message: `${name} back within its normal range`,
    },
  };
}

/**
 * Builds minute summaries out of the same stream of readings.
 *
 * The sweep's spike detection wants a minute's min and max. The other boxes
 * write those themselves; a box that keeps no minute history does not, and
 * the sweep was left with one live sample every two minutes. Since every
 * published reading already passes through here, summarising them costs
 * nothing extra: this hands back each minute once it is finished, and the
 * caller stores it in Firestore for the sweep to read.
 *
 * A minute is "finished" when a reading arrives for a LATER minute - there
 * is no timer, so nothing runs when no data does. With a ten-second
 * heartbeat that is at most ten seconds into the next minute.
 *
 * The mean is of published readings, not of every sample the box took, so it
 * is approximate; min and max are right to within one deadband step, which is
 * what the spike test actually uses.
 */
function createAccumulator() {
  const open = new Map();   // minute -> { tagKey: { min, max, sum, n } }
  let newest = 0;

  return {
    /** @returns finished minutes, oldest first: [{ minute, tags: { key: [min, avg, max, n] } }] */
    add(tagKey, value, ts) {
      if (!isNum(value) || !isNum(ts)) return [];
      const minute = Math.floor(ts / 60000) * 60000;

      let tags = open.get(minute);
      if (!tags) { tags = {}; open.set(minute, tags); }
      const a = tags[tagKey];
      if (!a) {
        tags[tagKey] = { min: value, max: value, sum: value, n: 1 };
      } else {
        if (value < a.min) a.min = value;
        if (value > a.max) a.max = value;
        a.sum += value;
        a.n += 1;
      }

      if (minute > newest) newest = minute;

      // Taken out of the map before they are handed back, so two readings
      // arriving together can never both flush the same minute.
      const done = [];
      for (const m of [...open.keys()].sort((x, y) => x - y)) {
        if (m >= newest) break;
        const closed = open.get(m);
        open.delete(m);
        const out = {};
        for (const [k, s] of Object.entries(closed)) {
          out[k] = [s.min, Number((s.sum / s.n).toFixed(4)), s.max, s.n];
        }
        done.push({ minute: m, tags: out });
      }
      return done;
    },
  };
}

const BOX_KINDS = new Set(['alarm-high', 'alarm-low', 'alarm-clear', 'alarm-reset', 'spike']);

/**
 * One alert reported by a box that evaluates its own (alertEvents/{device}).
 *
 * The box says WHAT happened; this decides whether it is news. A box
 * restates where every tag stands after a restart, because it cannot know
 * what it reported before - so "above its limit" from a tag already recorded
 * as above is not a second alert, and "back to normal" from a tag that was
 * never out is not an alert at all. `prev` is the state last recorded here.
 *
 *   alarm-high / alarm-low   crossed a limit
 *   alarm-clear              back inside its limits
 *   alarm-reset              the tag has no limit any more: settle it as ok,
 *                            and record nothing, since nothing happened to
 *                            the reading
 *   spike                    always recorded; it carries no state
 *
 * The wording is built here rather than taken from the box, so an alert
 * reads the same whichever side raised it.
 *
 * @returns { next, alert } - next is undefined when the state is untouched;
 *          alert is null when there is nothing to record. null overall for
 *          an event that makes no sense.
 */
function boxEventToAlert({ device, ev, prev = 'ok' }) {
  if (!ev || typeof ev !== 'object' || !BOX_KINDS.has(ev.kind)) return null;
  if (typeof ev.tagKey !== 'string' || !ev.tagKey || !isNum(ev.ts)) return null;

  const tagKey = ev.tagKey;
  const tagName = (typeof ev.tagName === 'string' && ev.tagName) || tagKey;
  const base = { ts: ev.ts, device, tagKey, tagName };
  if (isNum(ev.value)) base.value = ev.value;

  if (ev.kind === 'spike') {
    return {
      next: undefined,
      alert: {
        ...base, kind: 'spike', level: 'warning',
        message: `${tagName} jumped well outside its recent range`,
      },
    };
  }

  if (ev.kind === 'alarm-reset') return { next: 'ok', alert: null };

  if (ev.kind === 'alarm-clear') {
    if (prev === 'ok') return { next: 'ok', alert: null };
    return {
      next: 'ok',
      alert: {
        ...base, kind: 'alarm-clear', level: 'info',
        message: `${tagName} back within its normal range`,
      },
    };
  }

  const next = ev.kind === 'alarm-high' ? 'high' : 'low';
  if (prev === next) return { next, alert: null };
  const alert = {
    ...base, kind: ev.kind, level: 'critical',
    message: `${tagName} ${next === 'high' ? 'above its alert threshold' : 'below its alert threshold'}`,
  };
  if (isNum(ev.limit)) alert.limit = ev.limit;   // stored key kept for older records
  return { next, alert };
}

/** The worst of a device's tag states, as the overview shows it. */
function worstAlarm(tags = {}) {
  const states = Object.values(tags || {});
  return states.includes('high') ? 'high' : states.includes('low') ? 'low' : 'ok';
}

/** Function export name for a device's trigger: letters, digits, underscore. */
function triggerName(device) {
  return `liveAlerts_${String(device).replace(/[^A-Za-z0-9]/g, '_')}`;
}

module.exports = { thresholdStep, createAccumulator, triggerName, boxEventToAlert, worstAlarm };
