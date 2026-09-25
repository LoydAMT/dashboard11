'use strict';

// The landlord's view: one node per multi-device company, summarising every
// tenant in it.
//
// WHY A PROJECTION AND NOT 90 LISTENERS
// The obvious build has the mall page subscribe to devices/{id}/latest for
// every tenant. That works, and for ONE open tab it is actually cheaper than
// this - a listener sends the node once and then only what changed. It stops
// being cheap the moment several people in the mall office have it open, and
// it makes every one of them wait on ninety round trips before the page says
// anything.
//
// This is written from the sweep that ALREADY walks every device every two
// minutes to evaluate alerts. That sweep already reads status, tags and
// rules per device, so the marginal cost of the overview is one extra
// latest/ read - not a second pass over the whole estate. A dedicated
// overview sweep would have re-read everything on its own schedule and cost
// more than the listeners it replaced.
//
// WHAT IS DELIBERATELY NOT HERE
// No minute history and no per-tag trends. The mall gets live values, alert
// state, and the daily 22:00 meter reading. Anyone who wants a tenant's
// trend opens that tenant, where the existing dashboard already does it
// properly. Duplicating history into this node would multiply the very
// traffic the projection exists to avoid.

const STALE_AFTER_MS = 60000;   // matches the alert engine's offline test

// The range a tag has actually been seen in, from the minute rollups the
// sweep already holds. Sent instead of the readings themselves so a mall
// page can draw ninety dials without holding ninety sample buffers.
//
// EXTREMES, NOT A SIGMA BAND. The rollups carry min and max per minute, so
// this is the true swing of the instantaneous value. Deriving a band from
// the standard deviation of the minute AVERAGES instead - which is what
// this did first - produces something far too narrow, because averaging
// smooths the variance away. The live needle then sat pinned to one end of
// the dial with an off-scale arrow, on tag after tag.
//
// Padded by 5% so a reading sitting exactly at its recent extreme is not
// drawn touching the very end of the arc.
const RANGE_PAD = 0.05;

function rangeOf(rollups) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rollups || []) {
    if (!r) continue;
    if (isNum(r.min) && r.min < lo) lo = r.min;
    if (isNum(r.max) && r.max > hi) hi = r.max;
  }
  if (!isNum(lo) || !isNum(hi) || hi < lo) return null;
  if (hi === lo) {
    // A dead-constant tag still needs width, or the dial collapses to a
    // point and every reading reads as both ends at once.
    const pad = Math.max(Math.abs(lo) * 0.02, 1e-6);
    return { min: round(lo - pad), max: round(hi + pad) };
  }
  const pad = (hi - lo) * RANGE_PAD;
  return { min: round(lo - pad), max: round(hi + pad) };
}

// Six significant-ish digits. These ride in a node re-read by every viewer,
// and full float precision would triple its size to express noise.
function round(v) {
  return Number(v.toPrecision(6));
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * One tenant's row.
 *
 * @param deviceId
 * @param name      display name from naming/, falling back to the id
 * @param latest    devices/{id}/latest
 * @param status    devices/{id}/status
 * @param tagState  { tagKey: 'ok'|'high'|'low' } from the alert engine
 * @param offline   the engine's own verdict, when it has one
 * @param tagsMeta  devices/{id}/tags, for each reading's unit
 * @param rules     alertRules/{device}, so each dial knows its own zones
 * @param windows   the minute rollups the sweep already read, for the
 *                  baseline of a tag with no configured threshold
 * @param now       epoch ms
 *
 * `alarm` is the WORST state across the tenant's tags, because the mall's
 * question is "does this unit need attention", not "which tag". The tag
 * detail is one click away on the tenant's own page.
 */
function tenantRow({
  deviceId, name, latest, status, tagState = {}, offline = null,
  rules = {}, windows = [], tagsMeta = {}, now = Date.now(),
}) {
  const lastSeen = isNum(status?.lastSeen) ? status.lastSeen : null;
  // Prefer the engine's verdict; fall back to the clock so a tenant the
  // engine has never evaluated still reports honestly instead of defaulting
  // to "fine".
  const isOffline = offline === null
    ? (lastSeen === null ? true : (now - lastSeen) > STALE_AFTER_MS)
    : Boolean(offline);

  const states = Object.values(tagState);
  const alarm = isOffline ? 'offline'
    : states.includes('high') ? 'high'
    : states.includes('low') ? 'low'
    : 'ok';

  // Recent rollups per tag, from what the sweep already read. Kept whole
  // rather than reduced to averages: the min and max are the point.
  const recent = {};
  for (const w of windows) {
    for (const [k, r] of Object.entries(w?.byTag || {})) {
      if (r) (recent[k] = recent[k] || []).push(r);
    }
  }

  // Live values, one entry per tag, carrying everything a dial needs so the
  // page drawing ninety of them makes ONE subscription. Nulls are dropped
  // rather than written: absence already means "no reading", and RTDB treats
  // a null write as a delete anyway.
  const values = {};
  for (const [k, v] of Object.entries(latest || {})) {
    if (!v || !isNum(v.value)) continue;
    const entry = { v: round(v.value) };
    // The unit, so a tile can read "7.40 A" instead of "7.40 Current".
    // The sweep already holds tags/ to build alert names, so this costs
    // nothing beyond the bytes.
    const unit = tagsMeta[k] && tagsMeta[k].unit;
    if (typeof unit === 'string' && unit.length > 0) entry.u = unit;
    const rule = rules[k];
    if (rule && isNum(rule.lo)) entry.lo = rule.lo;
    if (rule && isNum(rule.hi)) entry.hi = rule.hi;
    // Only needed when there is no threshold to scale from - sending it
    // anyway would be bytes every viewer re-reads for nothing.
    if (!isNum(entry.lo) && !isNum(entry.hi)) {
      const r = rangeOf(recent[k]);
      if (r) { entry.rmin = r.min; entry.rmax = r.max; }
    }
    values[k] = entry;
  }

  return {
    device: deviceId,
    name: name || deviceId,
    alarm,
    online: !isOffline,
    lastSeen,
    values,
  };
}

/**
 * Totals across the tenants.
 *
 * Counts, not sums of readings: adding up ninety tenants' Current would
 * produce a number that looks like the mall's total load and is not one -
 * they are on different phases and different supplies, and some tenants are
 * offline and contributing a stale zero. A count of units needing attention
 * is something the number can actually support.
 */
function rollUp(rows) {
  const list = Object.values(rows || {});
  let inAlarm = 0;
  let offline = 0;
  let kwhToday = 0;
  let kwhKnown = 0;

  for (const r of list) {
    if (r.alarm === 'high' || r.alarm === 'low') inAlarm += 1;
    if (r.alarm === 'offline' || r.online === false) offline += 1;
    if (isNum(r.kwh?.deltaKwh)) { kwhToday += r.kwh.deltaKwh; kwhKnown += 1; }
  }

  return {
    tenants: list.length,
    inAlarm,
    offline,
    // Summed only over tenants whose delta is actually known, with the count
    // alongside it. A total that silently covers 40 of 90 units is a
    // misleading number unless it says so.
    kwhToday: kwhKnown > 0 ? Number(kwhToday.toFixed(3)) : null,
    kwhFrom: kwhKnown,
  };
}

module.exports = { tenantRow, rollUp, STALE_AFTER_MS };
