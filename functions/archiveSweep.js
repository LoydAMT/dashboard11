'use strict';

// Server-side archive + prune, on a schedule.
//
// The devices already do this themselves, and that is the problem. Doing it
// on the box means:
//
//   - the work is done over BLOCKING HTTP calls on a VM whose actual job is
//     reading sensors every second, so a 5000-key fetch shows up as a
//     40-second hole in the data
//   - the watermark lives in RAM (on two of the three boxes), so every
//     reboot - including every code deploy - forgets where it was and
//     strands every hour before that point, permanently
//   - it advances one hour per hour, which is exactly break-even: it can
//     keep pace but can never catch up on a backlog
//
// None of those are fixable from the server side of the wire, so this
// doesn't try to fix them - it just does the job somewhere the constraints
// do not apply. It is deliberately safe to run WHILE the devices are still
// doing their own version: archive writes use the same deterministic
// document ids, so a double-archive overwrites with identical content, and
// a delete of already-deleted keys is a no-op. A device that finds an hour
// already pruned reads an empty listing and advances, which if anything
// helps it catch up.
//
// Two watermarks, mirroring the design already proven on wecon3:
//   arHour - last hour successfully ARCHIVED to Firestore
//   rpHour - last hour whose rollups were then DELETED from RTDB
// rpHour can never pass arHour, so nothing is ever deleted from RTDB that
// Firestore has not already confirmed.

const HOUR_MS = 3600000;

function hourOf(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

// A stored rollup is {min, avg, max, n}. Anything else in that node -
// notably the sibling `raw` subtree - is not a rollup and is skipped rather
// than tripping over it.
function toTuples(rows) {
  const list = [];
  for (const [key, value] of Object.entries(rows || {})) {
    const t = Number(key);
    if (!Number.isFinite(t)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const { min, avg, max, n } = value;
    if (![min, avg, max, n].every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    list.push([t, min, avg, max, n]);
  }
  list.sort((a, b) => a[0] - b[0]);
  return list;
}

/**
 * @param devices               device ids to sweep
 * @param readTagKeys           (device) -> [tagKey]
 * @param readOldestRollupHour  (device, tags) -> hour | null, for first run
 * @param readHourRollups       (device, tag, hourStart) -> { minuteTs: {min,avg,max,n} }
 * @param writeArchiveHour      (device, hour, perTag) -> docs written
 * @param deleteHourRollups     (device, tags, hourStart) -> keys removed
 * @param readState/writeState  (device) -> { arHour, rpHour }
 * @param keepHours             hours of rollups to leave in RTDB, unpruned
 */
function createSweep({
  devices,
  readTagKeys,
  readOldestRollupHour,
  readHourRollups,
  writeArchiveHour,
  deleteHourRollups,
  readState,
  writeState,
  now = () => Date.now(),
  maxArchiveHours = 30,
  maxPruneHours = 30,
  keepHours = 48,
  log = () => {},
}) {
  async function sweepDevice(device) {
    const nowMs = now();
    // The hour in progress is still being written to, so the newest hour
    // eligible for archiving is the one before it.
    const closed = hourOf(nowMs) - HOUR_MS;
    // Recent rollups stay in RTDB so ordinary short-range charts never need
    // the archive at all. The +1 keeps this strictly OLDER than the
    // keepHours window rather than landing on its edge - when the operation
    // on the other end is a delete, the boundary should err toward keeping.
    const pruneCeiling = hourOf(nowMs) - (keepHours + 1) * HOUR_MS;

    const result = { device, archived: 0, docsWritten: 0, pruned: 0, keysRemoved: 0, error: null };
    let state = null;

    // Everything is inside the try, including the setup reads. With
    // readTagKeys outside it, a single unreachable device threw straight
    // out of sweep() and the remaining devices were never swept at all.
    try {
      const tags = await readTagKeys(device);
      if (!tags || tags.length === 0) {
        return { device, skipped: 'no tags published' };
      }

      state = await readState(device);
      if (!state || typeof state.arHour !== 'number') {
        const oldest = await readOldestRollupHour(device, tags);
        if (oldest == null) return { device, skipped: 'no rollups' };
        // Start one hour BEFORE the oldest, because the loops below advance
        // first and then process - so this makes the oldest hour the first
        // one actually handled rather than the one skipped.
        state = { arHour: oldest - HOUR_MS, rpHour: oldest - HOUR_MS };
        log(`${device}: first run, starting at ${new Date(oldest).toISOString()}`);
      }
      if (typeof state.rpHour !== 'number') state.rpHour = state.arHour;

      while (state.arHour < closed && result.archived < maxArchiveHours) {
        const target = state.arHour + HOUR_MS;
        const perTag = {};
        let any = false;

        for (const tag of tags) {
          const tuples = toTuples(await readHourRollups(device, tag, target));
          if (tuples.length > 0) {
            perTag[tag] = tuples;
            any = true;
          }
        }

        if (any) {
          result.docsWritten += await writeArchiveHour(device, target, perTag);
        }
        // Advances only after the write resolved. A throw above leaves the
        // watermark where it was, so the hour is retried rather than
        // silently skipped - the failure mode that stranded hours on the
        // devices in the first place.
        state.arHour = target;
        result.archived += 1;
      }

      const pruneLimit = Math.min(state.arHour, pruneCeiling);
      while (state.rpHour < pruneLimit && result.pruned < maxPruneHours) {
        const target = state.rpHour + HOUR_MS;
        result.keysRemoved += await deleteHourRollups(device, tags, target);
        state.rpHour = target;
        result.pruned += 1;
      }
    } catch (err) {
      // Recorded, not rethrown: one device failing must not stop the others,
      // and the watermark below still saves whatever completed.
      result.error = err && err.message ? err.message : String(err);
      log(`${device}: aborted - ${result.error}`);
    }

    // Written even on error, so completed hours are not redone next run.
    // Guarded on state: a failure in the setup reads above leaves nothing
    // meaningful to persist, and writing a half-built state would be worse
    // than writing none.
    if (state) {
      await writeState(device, { arHour: state.arHour, rpHour: state.rpHour });
      result.arHour = state.arHour;
      result.rpHour = state.rpHour;
    }
    return result;
  }

  return async function sweep() {
    const results = [];
    for (const device of devices) {
      results.push(await sweepDevice(device));
    }
    return results;
  };
}

module.exports = { createSweep, hourOf, toTuples, HOUR_MS };
