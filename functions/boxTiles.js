'use strict';

// Boxes that write their own mall-page tiles.
//
// WHY
// alertSweep used to read every meter every two minutes - its limits, its
// status, its live values and its newest minute rows - to build the tile on
// the mall page. Every one of those bytes is billed as download, and at a few
// hundred meters it was the largest part of the bill. The box already holds
// all of it in memory before it sends it, so a box flashed for it (TILES_ON_BOX
// in its script) now writes each tile's values itself, inside the batched
// request it sends anyway, and the sweep reads none of them.
//
// WHAT THE BOX WRITES
//   boxTenants/{box}           { tenant: true, ... } - its meters, on every start
//   boxSeen/{box}              { ts, alarm: { tenant: 'high'|'low' } } - every
//                              heartbeat (about 10 s); `alarm` lists only the
//                              tenants in alarm, so it is usually absent
//   mallOverview/{c}/tenants/{tenant}/values and /kwhLive - about every 2 min
//
// WHAT THE SWEEP STILL DOES FOR SUCH A TENANT
//   - the tile's name, alarm colour and online flag, from boxSeen (one small
//     read for every box at once) and the naming it already caches
//   - offline: a box that is off cannot say so. The moment boxSeen goes
//     stale (BOX_FRESH_MS) its tenants go back down the sweep's full path,
//     which reads each one's own status and raises "stopped reporting"
//     exactly as before. So does a box flashed back to a script without
//     tiles: it stops writing boxSeen, and the sweep simply takes over again.
//   - tileTargets/{box}: which mall pages each of its tenants is on, so the
//     box knows where to write. Written only when it changes.

// How old boxSeen may be before the box's tenants are read the full way
// again. Several heartbeats, so a slow request or two does not flip a box
// back and forth; well inside the 5-minute offline threshold, so "stopped
// reporting" is decided by the full path, from each tenant's own status.
const BOX_FRESH_MS = 90 * 1000;

// A box re-reads tileTargets about every 10 minutes, so for up to that long
// after a tenant first gets a mall page the box is not writing its tile yet.
// The sweep keeps writing it itself until this has passed. Counted from when
// THIS instance first saw the tenant listed, so a cold start errs the safe
// way: twelve minutes of the old, full read.
const TILE_SETTLE_MS = 12 * 60 * 1000;

/** Whether a tenant has been on its mall page long enough for its box to know. */
function tileSettled(since, now, settleMs = TILE_SETTLE_MS) {
  return isNum(since) && now - since >= settleMs;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** tenant -> the box that says it writes that tenant's tile. */
function boxOfTenant(boxTenants = {}) {
  const out = {};
  for (const [box, tenants] of Object.entries(boxTenants || {})) {
    if (!tenants || typeof tenants !== 'object') continue;
    for (const [dev, on] of Object.entries(tenants)) {
      // First box wins, and the order is fixed, so a meter listed by two
      // boxes (a mistake when flashing) is at least handled consistently.
      if (on === true && !out[dev]) out[dev] = box;
    }
  }
  return out;
}

/** Whether a box's heartbeat is recent enough to trust its tiles. */
function boxIsFresh(seen, now, freshMs = BOX_FRESH_MS) {
  return Boolean(seen && isNum(seen.ts) && now - seen.ts <= freshMs && seen.ts - now <= freshMs);
}

/** The colour the box reports for one tenant: 'high', 'low' or 'ok'. */
function boxAlarmOf(seen, dev) {
  const a = seen && seen.alarm && seen.alarm[dev];
  return a === 'high' || a === 'low' ? a : 'ok';
}

/**
 * Where each box should write its tenants' tiles:
 *   { box: { tenant: { companyId: true } } }
 * Only the companies with a mall page (overviewIds), and only tenants that
 * are on one. A box with none gets no entry, and writes no tiles.
 */
function tileTargets({ boxTenants = {}, deviceCompanies = {}, overviewIds = new Set() }) {
  const out = {};
  const owner = boxOfTenant(boxTenants);
  for (const [dev, box] of Object.entries(owner)) {
    const cs = (deviceCompanies[dev] || []).filter((c) => overviewIds.has(c));
    if (cs.length === 0) continue;
    out[box] = out[box] || {};
    out[box][dev] = {};
    for (const c of cs) out[box][dev][c] = true;
  }
  return out;
}

/** A tile row for a tenant whose box writes its values: the rest of it. */
function tiledRow({ deviceId, name, seen }) {
  return {
    device: deviceId,
    name: name || deviceId,
    alarm: boxAlarmOf(seen, deviceId),
    online: true,
    lastSeen: null,
    tiled: true,
  };
}

module.exports = {
  BOX_FRESH_MS, TILE_SETTLE_MS, boxOfTenant, boxIsFresh, boxAlarmOf, tileTargets, tileSettled, tiledRow,
};
