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
 * @param now       epoch ms
 *
 * `alarm` is the WORST state across the tenant's tags, because the mall's
 * question is "does this unit need attention", not "which tag". The tag
 * detail is one click away on the tenant's own page.
 */
function tenantRow({ deviceId, name, latest, status, tagState = {}, offline = null, now = Date.now() }) {
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

  // Live values, one number per tag. Nulls are dropped rather than written
  // as null: absence already means "no reading", and RTDB treats a null
  // write as a delete anyway.
  const values = {};
  for (const [k, v] of Object.entries(latest || {})) {
    if (v && isNum(v.value)) values[k] = v.value;
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
