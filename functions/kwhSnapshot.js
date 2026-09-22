'use strict';

// ============================================================================
//  Daily kWh record, one document per Philippine calendar day.
// ============================================================================
//
// WHY IT EXISTS
// A daily meter reading is wanted at 22:00 Philippine time. This is no longer
// a workaround: the boxes now take their own reading at exactly that moment
// (daily_at_utc = 14 in the Lua, 14:00 UTC = 22:00 PHT), and this function
// turns that reading into a per-day record with a day-over-day delta.
//
// It runs at 22:05, five minutes BEHIND the devices, so the reading it picks
// up is today's rather than yesterday's. `staleMs` is what proves that held:
// once every box is flashed it should sit at seconds. A number that lies
// about its own precision is worse than no number, so staleness is recorded
// rather than assumed.
//
// Until a box is flashed it still publishes kWh on its old interval, and
// staleMs for that device will show hours. That is the signal that the box
// is still on old firmware, not a fault here.
//
// METER RESETS
// A kWh accumulator should only ever rise. The simulated boxes reset theirs
// on every reboot (wecon2 returns to 1500, wecon3 to 8420), and a real meter
// can be replaced or roll over. Consumption is therefore NOT computed by
// naive subtraction: a fall is flagged as a suspected reset and that day's
// delta is left null rather than reported as negative usage.

const MS_PER_DAY = 86400000;
const PH_OFFSET_MS = 8 * 3600000;   // Philippine time is UTC+8, no DST

// The Philippine calendar day a moment belongs to, as YYYY-MM-DD. Done by
// shifting the epoch rather than with a date library so there is no
// dependency and no ambiguity about which timezone the server thinks it is in.
function phDateKey(ms) {
  return new Date(ms + PH_OFFSET_MS).toISOString().slice(0, 10);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Build one day's snapshot record.
 *
 * @param device    device id
 * @param latest    devices/{d}/latest/kWh -> { value, ts }
 * @param previous  the previous day's snapshot, or null
 * @param now       when the snapshot is being taken
 */
function buildSnapshot({ device, latest, previous = null, now }) {
  const dateKey = phDateKey(now);

  if (!latest || !isNum(latest.value)) {
    return {
      device,
      dateKey,
      takenAt: now,
      value: null,
      readingTs: null,
      staleMs: null,
      deltaKwh: null,
      resetSuspected: false,
      note: 'no kWh reading available',
    };
  }

  const readingTs = isNum(latest.ts) ? latest.ts : null;
  const staleMs = readingTs === null ? null : Math.max(0, now - readingTs);

  let deltaKwh = null;
  let resetSuspected = false;
  if (previous && isNum(previous.value)) {
    const d = latest.value - previous.value;
    if (d < 0) {
      // Accumulators do not run backwards. Something was reset, replaced or
      // rolled over - report that rather than a negative day's usage.
      resetSuspected = true;
    } else {
      deltaKwh = d;
    }
  }

  return {
    device,
    dateKey,
    takenAt: now,
    value: latest.value,
    readingTs,
    staleMs,
    deltaKwh,
    resetSuspected,
    // Carried on every record so a consumer never has to know the history of
    // this workaround to judge whether a number is trustworthy.
    note: staleMs !== null && staleMs > 15 * 60000
      ? 'reading older than 15 min - device still on the 12h kWh interval'
      : null,
  };
}

module.exports = { buildSnapshot, phDateKey, MS_PER_DAY, PH_OFFSET_MS };
