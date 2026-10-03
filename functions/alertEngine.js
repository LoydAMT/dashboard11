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
// pushes status/lastSeen every 10s, so even one minute of silence is
// unambiguous - but it is also what a routine script reload or a brief
// network blip looks like, and at 60 s every one of those was filed as
// "stopped reporting" followed by "reporting again" a moment later. Five
// minutes records the outages worth knowing about and not the noise.
const DEFAULT_OFFLINE_AFTER_MS = 5 * 60000;

// Spike detection, mirroring src/lib/alerts.js so the browser and the server
// agree about what counts as one.
//
// Without this the server log is nearly always EMPTY: no tag on any device
// has a threshold configured, so alarm-high/low cannot fire, and a healthy box
// never goes offline. A spike is the only thing most sites will ever record,
// which makes it the opposite of optional.
//
// The client tests each live sample against a trailing buffer of live
// samples. The server cannot - it sees minute rollups - so it tests the
// minute's EXTREME against a baseline of PAST EXTREMES OF THE SAME KIND:
// this minute's max against previous maxima, its min against previous
// minima.
//
// Comparing the max against a baseline of AVERAGES, which is what this did
// first, is not a stricter test - it is a broken one. A minute's maximum
// sits above the mean of past averages by construction, on any tag with
// variation within the minute, so the z-score measured that gap rather than
// anything unusual and the test fired almost every minute on almost every
// tag. The log filled with spikes for every device on every sweep, which is
// worse than having no spike detection at all: it buries the alerts that
// matter under ones that do not.
const SPIKE_MIN_SAMPLES = 8;
const SPIKE_Z_THRESHOLD = 4;
const SPIKE_MIN_DELTA_FRACTION = 0.02;
const SPIKE_BUFFER_LEN = 30;
// A tag can publish its own noise floor (tags/{key}/deadband - the smallest
// change the box considers worth reporting). A move smaller than this many
// of those steps is not a spike, whatever the statistics say. Mirrors
// SPIKE_DEADBAND_STEPS in src/lib/alerts.js.
//
// Needed because a quiet tag has a perfectly flat baseline: Free Chlorine
// sitting at 0.42 ppm for ten minutes has sd = 0, so the very next step to
// 0.44 was "infinitely many deviations out" and 4.7% off the mean - a spike
// by every test above, and in reality one tick of the sensor.
const SPIKE_DEADBAND_STEPS = 3;

/**
 * Is `value` a spike against `buffer` (minute averages, oldest first)?
 *
 * Z_THRESHOLD is deliberately conservative - a plain 2-3 sigma test fires
 * constantly on ordinary process noise. MIN_DELTA_FRACTION is the fallback
 * for a near-constant tag, where sd approaches zero and a z-score alone
 * would call a one-part-in-a-thousand wobble infinitely many deviations out.
 *
 * `minDelta` is an absolute floor in the tag's own units (see
 * SPIKE_DEADBAND_STEPS); 0 means none.
 */
function isSpike(buffer, value, minDelta = 0) {
  if (!Array.isArray(buffer) || buffer.length < SPIKE_MIN_SAMPLES) return false;
  if (!isNum(value)) return false;
  const mean = buffer.reduce((a, b) => a + b, 0) / buffer.length;
  const variance = buffer.reduce((a, b) => a + (b - mean) ** 2, 0) / buffer.length;
  const sd = Math.sqrt(variance);
  const delta = Math.abs(value - mean);
  if (isNum(minDelta) && minDelta > 0 && delta < minDelta) return false;
  if (delta < Math.abs(mean) * SPIKE_MIN_DELTA_FRACTION) return false;
  if (sd === 0) return delta > 0;
  return delta / sd >= SPIKE_Z_THRESHOLD;
}

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
 * @param spikeFloors { tagKey: smallest move that may count as a spike }
 * @param thresholds  false = record no threshold events and leave threshold
 *                    state untouched. For a device whose thresholds are
 *                    evaluated instantly by the live trigger (liveAlerts.js):
 *                    two evaluators would each record the same crossing.
 *                    `rules` is still used, to keep a spike from being filed
 *                    for the same minute as a threshold crossing.
 *
 * Returns { events, state }. Events are TRANSITIONS only - a tag that stays
 * past its threshold for an hour produces one alert, not sixty. A log that
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
  spikeFloors = {},
  thresholds = true,
}) {
  const events = [];
  const tagState = { ...(prevState.tags || {}) };
  // Trailing minute-averages per tag, carried across runs so the baseline
  // survives a restart instead of needing 8 fresh minutes to rebuild.
  const buffers = { ...(prevState.buffers || {}) };
  let lastMinute = prevState.lastMinute || 0;

  const name = (tagKey) => tagNames[tagKey] || tagKey;

  for (const w of windows) {
    if (!w || !isNum(w.minute) || w.minute <= lastMinute) continue;

    // Spike test runs on EVERY tag with history, not only those with a
    // configured threshold. A threshold catches a value someone decided to
    // watch for; a spike catches one nobody thought to watch for. Most tags here have the
    // second and not the first.
    for (const [tagKey, rollup] of Object.entries(w.byTag || {})) {
      if (!rollup || !isNum(rollup.avg)) continue;
      // Two buffers, and they matter: see the note on isSpike. An array here
      // is the OLD single-buffer state from before that fix - discarded
      // rather than migrated, because its contents are averages and reusing
      // them as a max baseline would reproduce the very bias being removed.
      // The cost is one quiet window per tag while the new buffers fill.
      const prevBuf = buffers[tagKey];
      const buf = (prevBuf && !Array.isArray(prevBuf) && prevBuf.hi && prevBuf.lo)
        ? prevBuf
        : { hi: [], lo: [] };

      // Suppress the spike when this same minute also crosses a configured
      // threshold: it is one excursion, and reporting it as both a spike and an
      // alarm is the same event told twice.
      //
      // Classified fresh from THIS minute rather than read from tagState.
      // tagState is only updated by the threshold loop further down, so reading
      // it here would see the previous minute's verdict and let both fire
      // on the very transition that matters most - which is exactly what
      // the first version of this did.
      const cls = classify(rollup, rules[tagKey]);
      const hi = isNum(rollup.max) ? rollup.max : rollup.avg;
      const lo = isNum(rollup.min) ? rollup.min : rollup.avg;

      if (cls !== 'high' && cls !== 'low') {
        // This minute's HIGH against past highs, and its LOW against past
        // lows. Comparing a max against a baseline of averages is what the
        // first version did, and it fired on nearly every minute of every
        // tag: a minute's maximum is systematically above the mean of past
        // averages, so the test was measuring that bias rather than
        // anything unusual. The alert log filled with "jumped well outside
        // its recent range" for every device on every sweep, which is worse
        // than no spike detection - it buries the alerts that matter.
        const floor = spikeFloors[tagKey] || 0;
        const spikeHigh = isSpike(buf.hi, hi, floor);
        const spikeLow = isSpike(buf.lo, lo, floor);
        if (spikeHigh || spikeLow) {
          const value = spikeHigh ? hi : lo;
          events.push({
            ts: w.minute,
            device,
            kind: 'spike',
            level: 'warning',
            tagKey,
            tagName: name(tagKey),
            value,
            message: `${name(tagKey)} jumped well outside its recent range`,
          });
        }
      }

      buffers[tagKey] = {
        hi: [...buf.hi, hi].slice(-SPIKE_BUFFER_LEN),
        lo: [...buf.lo, lo].slice(-SPIKE_BUFFER_LEN),
      };
    }

    for (const [tagKey, rule] of Object.entries(thresholds ? rules : {})) {
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
          limit: next === 'high' ? rule.hi : rule.lo,   // stored key kept for older records
          message: `${name(tagKey)} ${next === 'high' ? 'above its alert threshold' : 'below its alert threshold'}`,
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
          message: `${name(tagKey)} back within its normal range`,
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
    state: { tags: tagState, buffers, offline: offlineNow, lastMinute },
  };
}

// A tag counts as "on minute rollups" once it has this many history rows in
// the sweep's lookback. A one-minute tag has ~15 there; a tag that stores a
// snapshot every 30 minutes has one or none.
const LIVE_MIN_ROLLUPS = 3;
// A latest/ reading older than this is not evaluated: it says nothing about
// now, and the offline check already covers a box that has gone quiet.
const LIVE_MAX_AGE_MS = 5 * 60000;

/**
 * Adds a window built from latest/ for tags that have NO minute rollups.
 *
 * WHY THIS EXISTS
 * The engine evaluates history rows, and that is the right call for a box
 * that writes one every minute - the row carries the minute's min and max.
 * But a box can be configured to keep only a periodic snapshot (UMPD-MCWD
 * stores one row per tag every 30 minutes and no rollups at all). For that
 * device the engine saw one reading per half hour: a threshold crossed at
 * 14:10 and cleared by 14:25 was never evaluated, and nothing was recorded.
 *
 * For those tags the live value is the only signal there is, so it is
 * evaluated on every sweep instead. It is a point sample, not a min/max, so
 * an excursion shorter than the sweep interval can still be missed - but the
 * alternative was missing everything shorter than half an hour.
 *
 * A tag that DOES have minute rollups is left alone: its rollups are
 * strictly better evidence, and mixing a live sample into the same minute
 * would only advance the watermark past a rollup that has not landed yet.
 *
 * @param windows  history windows, ascending (as built by alertSweep)
 * @param latest   devices/{id}/latest -> { tagKey: { value, ts } }
 * @param tagKeys  tags the sweep evaluates
 * @returns a new ascending windows array; `windows` itself is not modified
 */
function withLiveWindow({ windows = [], latest = {}, tagKeys = [], now = Date.now() }) {
  const counts = {};
  for (const w of windows) {
    for (const k of Object.keys((w && w.byTag) || {})) counts[k] = (counts[k] || 0) + 1;
  }

  const byTag = {};
  let newest = 0;
  for (const k of tagKeys) {
    if ((counts[k] || 0) >= LIVE_MIN_ROLLUPS) continue;
    const e = latest ? latest[k] : null;
    if (!e || !isNum(e.value) || !isNum(e.ts)) continue;
    if (now - e.ts > LIVE_MAX_AGE_MS) continue;
    byTag[k] = { min: e.value, avg: e.value, max: e.value, n: 1 };
    if (e.ts > newest) newest = e.ts;
  }
  if (newest === 0) return windows;

  const minute = Math.floor(newest / 60000) * 60000;
  const out = windows.map((w) => ({ minute: w.minute, byTag: { ...(w.byTag || {}) } }));
  const existing = out.find((w) => w.minute === minute);
  if (existing) {
    // A history row for this very minute (the snapshot itself) wins over the
    // live sample for the same tag; the live sample fills in the rest.
    existing.byTag = { ...byTag, ...existing.byTag };
  } else {
    out.push({ minute, byTag });
    out.sort((a, b) => a.minute - b.minute);
  }
  return out;
}

/**
 * Tags that publish a per-minute alert summary (tags/{key}/minuteAlerts).
 *
 * A box that keeps no minute history can still send each minute's min, mean
 * and max to alertWindows/{device}/{minute} purely for alerting - see
 * parseAlertWindows. When ANY tag on a device carries the flag, the whole
 * device is evaluated from those summaries and from nothing else: no history
 * rows and no live window. Mixing sources on one device would let a live
 * sample for the current, unfinished minute advance the watermark past the
 * summary for that same minute, which arrives a minute later and would then
 * be skipped as already seen.
 */
function alertWindowTags(tagsMeta = {}) {
  return Object.entries(tagsMeta || {})
    .filter(([, m]) => m && m.minuteAlerts === true)
    .map(([k]) => k);
}

/**
 * alertWindows/{device} -> ascending windows for evaluate().
 *
 * WHY THIS NODE EXISTS
 * The engine wants a minute's min and max, so a two-second excursion is
 * caught. A box that stores only a 30-minute snapshot has no such rows, and
 * sampling latest/ every sweep sees one instant in every two minutes. So the
 * box sends the summary itself - computed from every 1 Hz sample - to a node
 * no dashboard listens to. This sweep reads it once and deletes what it has
 * processed, so it costs a few hundred bytes of download per minute and
 * nothing is kept: the lasting record is the alert written to Firestore.
 *
 * Each tag is [min, avg, max, n] - an array rather than named fields because
 * it is written and read every minute for the life of the device. The object
 * form is accepted too.
 */
function parseAlertWindows(node) {
  const out = [];
  for (const [minuteKey, tags] of Object.entries(node || {})) {
    const minute = Number(minuteKey);
    if (!Number.isFinite(minute) || !tags || typeof tags !== 'object') continue;
    const byTag = {};
    for (const [tagKey, r] of Object.entries(tags)) {
      const row = Array.isArray(r)
        ? { min: r[0], avg: r[1], max: r[2], n: r[3] }
        : r;
      if (!row || !isNum(row.avg)) continue;
      byTag[tagKey] = {
        min: isNum(row.min) ? row.min : row.avg,
        avg: row.avg,
        max: isNum(row.max) ? row.max : row.avg,
        n: isNum(row.n) ? row.n : 1,
      };
    }
    if (Object.keys(byTag).length > 0) out.push({ minute, byTag });
  }
  return out.sort((a, b) => a.minute - b.minute);
}

/** Per-tag spike floors from tags/ metadata. See SPIKE_DEADBAND_STEPS. */
function spikeFloorsFromTags(tagsMeta = {}) {
  const floors = {};
  for (const [k, m] of Object.entries(tagsMeta || {})) {
    if (m && isNum(m.deadband) && m.deadband > 0) floors[k] = m.deadband * SPIKE_DEADBAND_STEPS;
  }
  return floors;
}

// Deterministic id, so a re-run over the same window cannot duplicate an
// alert. Firestore .set() on the same id overwrites with identical content
// instead of appending a second copy - the same property the archive relies
// on, and the reason a retry after a partial failure is safe.
function alertId(ev) {
  const tag = ev.tagKey || '_device';
  return `${ev.ts}_${tag}_${ev.kind}`;
}

module.exports = {
  evaluate, classify, isSpike, alertId, withLiveWindow,
  alertWindowTags, parseAlertWindows, spikeFloorsFromTags,
  DEFAULT_OFFLINE_AFTER_MS, SPIKE_DEADBAND_STEPS,
};
