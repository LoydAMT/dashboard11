'use strict';

// Hourly health of every box, for the admin /performance page.
//
// Worked out ONCE an hour on the server (at the end of archiveSweep, which
// already runs hourly) and stored as a few hundred bytes per box under
// boxHealth/. The page only reads that, so ten admins with it open cost no
// more than one, and no browser ever reads a meter's history to draw it.
//
// Everything here is pure: the reads are done by the caller.

const MIN = 60000;
// Hourly snapshots kept for the page's trend strip.
const KEEP_HOURS = 48;

/** The box a meter belongs to: "ayala-box1-9" -> "ayala-box1". */
function boxOf(deviceId) {
  return String(deviceId).replace(/-\d+$/, '');
}

/** The tag whose minute rows show a box's pace: Current if it has one. */
function paceTag(tags = {}) {
  if (tags.Current) return 'Current';
  const keys = Object.keys(tags)
    .filter((k) => tags[k] && tags[k].history !== false && !(tags[k].intervalMs >= 60000))
    .sort();
  return keys[0] || null;
}

/** The most common value, or null. */
function mode(values) {
  const counts = new Map();
  let best = null;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN || (n === bestN && v > best)) { best = v; bestN = n; }
  }
  return best;
}

/**
 * One box's last hour.
 *
 * @param meters [{ id, lastSeen, rows: [{ t, n }], dailyTs, kwhTs }]
 *   rows     the pace tag's minute rows from about the last hour
 *   dailyTs  the newest 22:00 meter reading, or null
 *   kwhTs    when the meter total was last read, or null
 * @param now    ms
 *
 * The window is the 60 whole minutes ending two minutes ago: the newest
 * minute may not have been sent yet, and is not a fault.
 */
function summarizeBox({ meters, now }) {
  const end = Math.floor(now / MIN) * MIN - 2 * MIN;
  const start = end - 59 * MIN;
  const slots = [];
  for (let t = start; t <= end; t += MIN) slots.push(t);

  const inWindow = (r) => r && typeof r.t === 'number' && typeof r.n === 'number' && r.t >= start - 9 * MIN && r.t <= end;
  const byMeter = meters.map((m) => ({ ...m, rows: (m.rows || []).filter(inWindow) }));
  const reading = byMeter.filter((m) => m.rows.some((r) => r.t >= start));

  // Readings a healthy minute holds, learned from the box itself - 30 on one
  // script, 15 on another - so nothing here has to be told.
  const expected = mode(reading.flatMap((m) => m.rows.map((r) => r.n))) || 0;
  // A row holding far more than a minute's readings is a 10-minute row the
  // box built while it could not upload: those minutes arrived late, but
  // they did arrive.
  const isHeld = (r) => expected > 0 && r.n > expected * 1.5;

  const onTime = new Set();
  const late = new Set();
  let full = 0;
  let normal = 0;
  for (const m of reading) {
    for (const r of m.rows) {
      if (isHeld(r)) {
        for (let k = 0; k < 10; k += 1) late.add(r.t + k * MIN);
      } else if (r.t >= start) {
        onTime.add(r.t);
        normal += 1;
        // Within a tenth: a box reading once a second lands 58 or 59 in a
        // minute as often as 60, and that is not a short minute.
        if (r.n >= expected * 0.9) full += 1;
      }
    }
  }
  // A box that only sends a row when a reading changes (UMPD-MCWD: one
  // reading per row) leaves quiet minutes empty on purpose. Counting those
  // as missing would mark a healthy box as failing, so they are not counted.
  const everyMinute = expected >= 3;
  let missing = 0;
  let held = 0;
  for (const t of everyMinute ? slots : []) {
    if (onTime.has(t)) continue;
    if (late.has(t)) held += 1;
    else missing += 1;
  }

  const lastSeen = Math.max(0, ...meters.map((m) => Number(m.lastSeen) || 0));
  const dailies = meters.map((m) => m.dailyTs).filter((v) => typeof v === 'number');
  const kwhs = meters.map((m) => m.kwhTs).filter((v) => typeof v === 'number');

  return {
    at: now,
    meters: meters.length,
    reading: reading.length,
    silent: byMeter.filter((m) => !reading.includes(m)).map((m) => m.id).sort(byNumber),
    heartbeatAgeS: lastSeen ? Math.round((now - lastSeen) / 1000) : null,
    perMinute: expected,
    fullPct: normal ? Math.round((full / normal) * 100) : null,
    // Of the 60 minutes: sent late as 10-minute rows, or not arrived at all.
    lateMinutes: everyMinute ? held : null,
    missingMinutes: everyMinute ? missing : null,
    kwhAgeS: kwhs.length ? Math.round((now - Math.max(...kwhs)) / 1000) : null,
    lastDaily: dailies.length ? Math.max(...dailies) : null,
  };
}

/**
 * Good, watch or problem - what the page colours a box by.
 *
 * Silent meters do not count: a box with a meter switched off at the site
 * is not unhealthy, and flagging it for ever would hide a real fault.
 */
function verdict(s, now) {
  if (!s) return 'problem';
  const dailyLate = s.lastDaily != null && now - s.lastDaily > 26 * 3600e3;
  if (s.heartbeatAgeS == null || s.heartbeatAgeS > 180 || s.reading === 0 || dailyLate) return 'problem';
  const lost = (s.missingMinutes || 0) + (s.lateMinutes || 0);
  if (lost >= 5 || (s.fullPct != null && s.fullPct < 90)) return 'watch';
  return 'good';
}

const byNumber = (a, b) => a.localeCompare(b, undefined, { numeric: true });

module.exports = { boxOf, paceTag, summarizeBox, verdict, KEEP_HOURS };
