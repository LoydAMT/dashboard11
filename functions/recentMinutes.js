'use strict';

// The last quarter-hour of minute rollups per meter, remembered between
// alertSweep runs so each run downloads only the minutes that are new.
//
// WHY. For a box that judges its own alarms, the sweep reads recent minutes
// for one thing only: the range a dial on the mall page is scaled to
// (mallOverview.js: rangeOf). It used to read the whole 15-minute window on
// every 2-minute run - each minute downloaded about seven times over. Now
// the first run reads the window and every run after reads from the newest
// minute it already holds, which is the same window built from pieces.
//
// Held in the function's memory. alertSweep runs one instance at a time
// (maxInstances: 1), so the next run normally finds it; when the instance
// has been replaced it is simply empty, and that run reads the full window
// exactly as before.
//
// What it does NOT see: a minute row that arrives after a newer one, which
// is what a box sending held-back 10-minute rows after an outage does. Those
// count toward the dial's range only if they are inside the window on a
// later full read. Only the dial scale is affected - alarms never read this.

function createRecentMinutes() {
  // device -> tagKey -> minute -> row
  const cache = new Map();

  const tagMap = (device, tagKey, create) => {
    let byTag = cache.get(device);
    if (!byTag) {
      if (!create) return null;
      byTag = new Map();
      cache.set(device, byTag);
    }
    let rows = byTag.get(tagKey);
    if (!rows && create) {
      rows = new Map();
      byTag.set(tagKey, rows);
    }
    return rows || null;
  };

  return {
    /**
     * Where this run's read should start: the newest minute already held
     * (read again, in case it was still being written), or the window's
     * start when nothing recent is held.
     */
    startFor(device, tagKey, since) {
      const rows = tagMap(device, tagKey, false);
      if (!rows || rows.size === 0) return since;
      let newest = -Infinity;
      for (const t of rows.keys()) if (t > newest) newest = t;
      return Math.max(since, newest);
    },

    /** Adds what was read and forgets anything older than the window. */
    absorb(device, tagKey, node, since) {
      const rows = tagMap(device, tagKey, true);
      for (const [minute, r] of Object.entries(node || {})) {
        const t = Number(minute);
        if (!Number.isFinite(t) || !r || typeof r !== 'object') continue;
        rows.set(t, r);
      }
      for (const t of rows.keys()) if (t < since) rows.delete(t);
    },

    /** The held window as the sweep's { minute, byTag } list, oldest first. */
    windows(device, tagKeys, since) {
      const byMinute = new Map();
      for (const tagKey of tagKeys) {
        const rows = tagMap(device, tagKey, false);
        if (!rows) continue;
        for (const [t, r] of rows) {
          if (t < since) continue;
          if (!byMinute.has(t)) byMinute.set(t, { minute: t, byTag: {} });
          byMinute.get(t).byTag[tagKey] = r;
        }
      }
      return [...byMinute.values()].sort((a, b) => a.minute - b.minute);
    },
  };
}

module.exports = { createRecentMinutes };
