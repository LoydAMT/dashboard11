'use strict';

// A small time-limited memory for things a scheduled function reads on every
// run and that almost never change.
//
// WHY THIS EXISTS
// alertSweep walks every device every two minutes. Most of what it read per
// device - the tag list, the alert limits, the display name - changes about
// once a month, so 99% of those reads fetched the same bytes they fetched two
// minutes earlier. At 150 devices that is hundreds of thousands of database
// reads a day for nothing, and database downloads are the billed resource.
//
// The copy lives in the function instance's memory. alertSweep is
// maxInstances 1 and runs every two minutes, so one warm instance serves
// nearly every run; after a cold start the cache is simply empty and the
// first run reads everything, exactly as before. Nothing here can make the
// sweep wrong, only slightly slower to notice a change - by at most `ttlMs`.

/**
 * Returns the cached value for `key` while it is younger than `ttlMs`,
 * otherwise runs `loader`, remembers the result and returns it.
 *
 * A loader that throws caches nothing, so a failed read is retried on the
 * next call instead of being remembered. `null` is a valid value to cache
 * (a device with no display name), and is told apart from "never read".
 */
async function cachedRead(cache, key, ttlMs, now, loader) {
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = await loader();
  cache.set(key, { at: now, value });
  return value;
}

module.exports = { cachedRead };
