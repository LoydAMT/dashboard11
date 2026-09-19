'use strict';

// ============================================================================
//  TEMPORARY. Remove this once the devices publish kWh every 10 minutes.
// ============================================================================
//
// WHY IT EXISTS
// A daily meter reading is wanted at 22:00 Philippine time. The devices
// currently publish kWh on a 12-HOUR interval, so at 22:00 the newest value
// available may have been taken at 10:00 that morning - and every kWh
// consumed in between lands on the wrong day.
//
// This records the best value available at 22:00 and, crucially, records HOW
// STALE it was. A number that lies about its own precision is worse than no
// number, and a billing figure quietly carrying twelve hours of drift is
// exactly that.
//
// THE REAL FIX is one config value in the Lua: kWh interval_ms from
// 12 * 3600000 to 600000. That is already applied in the Desktop copies,
// pending a deploy. Once every box is running it, `staleMs` here will sit
// under ten minutes and this whole file can go - or stay, harmlessly, as a
// convenience index over the archive.
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
