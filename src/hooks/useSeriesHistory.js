import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ref, query, orderByKey, startAt, endAt, limitToFirst, limitToLast, get, onValue,
} from 'firebase/database'
import { db } from '../firebase'
import { floorToMinute, MINUTE } from '../lib/time'
import { isRawRange } from '../lib/ranges'

// Bounds each raw backfill request. Firebase does not hard-cap how many
// children a query can return, but asking for a quarter million rows - the
// longest raw range, at the device's ~1-second push rate - in one response is
// still the wrong shape for a phone: one huge parse, one huge state update,
// and nothing rendered until all of it lands. Paging keeps every individual
// request small regardless of how wide the window is, and lets rows appear as
// pages arrive instead of all at once at the end.
const RAW_PAGE_SIZE = 10000

// A tag reporting slower than once a minute can never put two samples in the
// same minute bucket, so the device does not bother building one — its
// history lives only under raw/. This is the same cutoff from the other
// direction: a tag faster than this can, so a rollup means something there.
// Reading it off intervalMs, rather than a tag name, is what keeps a new slow
// tag working without a code change.
const ROLLUP_CEILING_MS = MINUTE
const usesRawOnly = (intervalMs) =>
  typeof intervalMs === 'number' && intervalMs >= ROLLUP_CEILING_MS

// RTDB orders integer-parseable keys before every non-numeric key, regardless
// of magnitude - so any numeric endAt, however large, excludes a sibling
// string key like "raw" without needing to know where it sits. This is not a
// real time bound; it only has to outlive every minuteEpoch this app will
// ever see, which a 13-digit ceiling does for the next few centuries.
const ROLLUP_KEY_CEILING = '9999999999999'

/**
 * History for several tags at once, one subscription per tag.
 *
 * Same two-part strategy as a single series — a bounded `get()` for the window,
 * then a `limitToLast(2)` listener for the leading edge — but held per tag so
 * the set on screen can change without disturbing the tags already loaded.
 *
 * That incremental diff is the whole point of the file. Tearing every listener
 * down and rebuilding on each toggle would re-download the full window for tags
 * that were already drawn, and bandwidth is the billed resource here: showing a
 * second trend should cost one more window, not two.
 *
 * Rows are cached in the units RTDB holds. The merge onto a common time grid
 * happens downstream, in lib/series.js.
 *
 * A tag is read from one of two places, decided by either of two things:
 *   - history/{key}/{minuteEpoch}  {min,avg,max,n} rollups, for a tag fast
 *     enough that a minute can hold more than one sample.
 *   - history/{key}/raw/{ts}       a bare number per sample, read whenever
 *     either the tag itself never gets a rollup (see usesRawOnly - a 12-hour
 *     accumulator, always) or the *range* on screen asks for one (see
 *     lib/ranges.js's RAW_RANGES - a deliberately short recent window, for
 *     any tag, when someone wants to see actual pushes rather than rollups).
 *     Each raw sample becomes its own row with min = avg = max = that value
 *     and n = 1, which is exactly the shape a single-sample minute would have
 *     had - so everything downstream (the chart, the table, CSV/XLSX export)
 *     reads it without knowing the difference.
 * Both live under history/{key} as siblings now, which is why the rollup
 * queries below carry an explicit endAt: without it, orderByKey with no upper
 * bound would sweep the raw/ subtree in as well, on every backfill and on
 * every live-tail update raw/ receives - for a once-a-second tag, that is a
 * refire on every single sample instead of once a minute.
 *
 * Cache and subscription identity is keyed on the range's *id*, not its `ms`
 * - a raw range and a rollup range can share the same duration (raw-1h and
 * 1h are both an hour) while needing completely different data, and `ms`
 * alone cannot tell them apart. `deviceId` is folded into that same identity
 * so a device switch (via the picker) cannot serve one device's cached rows
 * under another's key, even though in practice a switch remounts this hook
 * entirely rather than changing `deviceId` on a live instance.
 */
export function useSeriesHistory(tags, range, deviceId, enabled = true) {
  // Rows are state, not a ref: they are read while rendering, and a ref read
  // during render is not guaranteed to have been seen by React.
  //
  // Entries are keyed by tag *and* window, which is what lets a hidden tag be
  // dropped without clearing anything: a re-shown tag either finds rows that
  // are still valid for the window on screen and redraws at once, or finds
  // none and backfills. Nothing has to be evicted, so no state is written
  // while reconciling.
  const [store, setStore] = useState({})   // `${tagKey}@${rangeMs}` -> { rows, error }

  // Subscriptions are the opposite case — touched only from effects, never
  // during render — so a ref is the right home for them.
  const subs = useRef(new Map())

  // Tag objects, kept fresh via effect rather than closed over directly, so
  // the reconciliation effect below can still key off the stable keysId
  // string and not resubscribe every tag merely because intervalMs (which
  // does not change at runtime in practice) gave the array a new identity.
  const tagsRef = useRef(tags)
  useEffect(() => {
    tagsRef.current = tags
  }, [tags])

  const keysId = enabled ? [...new Set(tags.map((t) => t.key))].filter(Boolean).join(' ') : ''

  useEffect(() => {
    const keyList = keysId ? keysId.split(' ') : []
    const wanted = new Set(keyList)

    // Close listeners for what is no longer shown, and for anything whose
    // window changed — a wider range needs a deeper backfill than the one
    // already in hand. The rows they gathered stay cached under their own
    // window key.
    for (const [key, sub] of subs.current) {
      if (!wanted.has(key) || sub.rangeId !== range.id || sub.deviceId !== deviceId) {
        sub.cancelled = true
        sub.unsubscribe()
        subs.current.delete(key)
      }
    }

    for (const key of keyList) {
      if (subs.current.has(key)) continue

      const sub = { rangeId: range.id, deviceId, cancelled: false, unsubscribe: () => {} }
      subs.current.set(key, sub)

      // Decided once, at the moment this subscription is (re)established -
      // the same moment a key/range change would rebuild it anyway, so a
      // config change on the device is picked up the next time this tag's
      // subscription is touched, without needing its own reactivity.
      const tag = tagsRef.current.find((t) => t.key === key)
      const rawOnly = usesRawOnly(tag?.intervalMs) || isRawRange(range)

      const devicePath = `devices/${deviceId}/history/${key}`
      const path = rawOnly ? `${devicePath}/raw` : devicePath
      const slot = `${deviceId}:${key}@${range.id}`
      const since = floorToMinute(Date.now() - range.ms)

      // Keyed by timestamp so the backfill and the live tail merge without
      // duplicating whichever point both of them see.
      const rowsByTime = new Map()

      // Rollups arrive as {min,avg,max,n} objects; raw samples as a bare
      // number. Normalising both to the same row shape here is what lets
      // every consumer downstream - the chart, the table, CSV/XLSX export -
      // stay written against "a minute's worth of readings" without ever
      // needing to know which source a given tag actually came from.
      //
      // Every call commits to the store, even one carrying nothing - a tag
      // can legitimately have zero rollups (kWh, always) or zero raw samples
      // in a short window (a 12-hourly tag on a 1h range), and that has to
      // read as "answered, nothing here" rather than leave `ready` uncounted
      // and the loading state waiting on a snapshot that already arrived.
      const absorb = rawOnly
        ? (raw) => {
            for (const [tsKey, v] of Object.entries(raw || {})) {
              const t = Number(tsKey)
              if (!Number.isFinite(t) || typeof v !== 'number' || !Number.isFinite(v)) continue
              rowsByTime.set(t, { t, min: v, max: v, avg: v, n: 1 })
            }
            const rows = [...rowsByTime.values()].sort((a, b) => a.t - b.t)
            setStore((prev) => ({ ...prev, [slot]: { rows, error: null } }))
          }
        : (raw) => {
            for (const [minute, v] of Object.entries(raw || {})) {
              const t = Number(minute)
              if (!Number.isFinite(t) || v == null) continue
              rowsByTime.set(t, {
                t,
                min: numOr(v.min, v.avg),
                max: numOr(v.max, v.avg),
                avg: numOr(v.avg, null),
                n: typeof v.n === 'number' ? v.n : 1,
              })
            }
            const rows = [...rowsByTime.values()].sort((a, b) => a.t - b.t)
            setStore((prev) => ({ ...prev, [slot]: { rows, error: null } }))
          }

      const fail = (error) => {
        if (sub.cancelled) return
        setStore((prev) => ({ ...prev, [slot]: { rows: [], error } }))
      }

      // A rollup-mode query is bounded above at a key that will never be
      // reached by a real minuteEpoch, purely to keep the now-sibling raw/
      // node out of it (see ROLLUP_KEY_CEILING above). Raw mode is already
      // reading inside raw/ itself, so it has no such sibling to exclude.
      const tailQuery = rawOnly
        ? query(ref(db, path), orderByKey(), limitToLast(2))
        : query(ref(db, path), orderByKey(), endAt(ROLLUP_KEY_CEILING), limitToLast(2))

      // 1. Backfill this tag's window. Rollups are small even at 7 days
      // (10,080 rows) and fetched in one shot; raw can be a quarter million
      // rows at the 3-day ceiling and is paginated instead (see
      // fetchRawBackfill / RAW_PAGE_SIZE above).
      if (rawOnly) {
        fetchRawBackfill({ path, since, sub, absorb, fail })
      } else {
        get(query(ref(db, path), orderByKey(), startAt(String(since)), endAt(ROLLUP_KEY_CEILING)))
          .then((snap) => {
            if (sub.cancelled) return
            absorb(snap.val())
          })
          .catch(fail)
      }

      // 2. Follow its leading edge.
      sub.unsubscribe = onValue(
        tailQuery,
        (snap) => {
          if (sub.cancelled) return
          absorb(snap.val())
        },
        fail,
      )
    }

    // No cleanup returned on purpose: this effect reconciles subscriptions, it
    // does not own them. Ownership ends at unmount, handled once below.
    //
    // Depends on `range` itself, not just `range.id`: both `.id` and `.ms` are
    // read above, and range objects are the stable module constants from
    // lib/ranges.js, so this re-runs exactly when the id would have anyway.
  }, [keysId, range, deviceId])

  useEffect(() => {
    const active = subs.current
    return () => {
      for (const sub of active.values()) {
        sub.cancelled = true
        sub.unsubscribe()
      }
      active.clear()
    }
  }, [])

  return useMemo(() => {
    const keyList = keysId ? keysId.split(' ') : []
    const byKey = {}
    let error = null
    let ready = 0

    for (const key of keyList) {
      const entry = store[`${deviceId}:${key}@${range.id}`]
      byKey[key] = entry?.rows || []
      if (entry?.error && !error) error = entry.error
      if (entry) ready += 1
    }

    return {
      byKey,
      error,
      // Loading until every requested tag has answered. A half-drawn overlay
      // invites reading a trend that has not arrived as one that is flat.
      loading: keyList.length > 0 && ready < keyList.length,
    }
  }, [keysId, store, range, deviceId])
}

/**
 * Walk history/{tag}/raw/ from `since` to the present in RAW_PAGE_SIZE
 * chunks, feeding each page to `absorb` as it arrives rather than waiting for
 * the whole window.
 *
 * Cursor-based, not offset-based: each page's start is one past the newest
 * key the previous page returned, so a page can never be requested until the
 * one before it is known - correct over a fast/cheap-but-serial round trip,
 * not a set of ranges guessed up front and fetched in parallel. Given that
 * device pushes are not perfectly even (a reconnect, a slow cycle), guessing
 * time-based page boundaries in advance risks either re-fetching a stretch
 * that was already covered or, worse, skipping one that was not.
 */
async function fetchRawBackfill({ path, since, sub, absorb, fail }) {
  let cursor = since

  for (;;) {
    if (sub.cancelled) return

    let snap
    try {
      snap = await get(
        query(ref(db, path), orderByKey(), startAt(String(cursor)), limitToFirst(RAW_PAGE_SIZE)),
      )
    } catch (error) {
      fail(error)
      return
    }
    if (sub.cancelled) return

    const page = snap.val()
    const keys = page ? Object.keys(page) : []
    absorb(page)

    // Fewer than a full page means this was the last one - whatever is newest
    // in raw/ right now has been reached, and the live-tail listener picks up
    // anything pushed after this point.
    if (keys.length < RAW_PAGE_SIZE) return

    // The largest key, not `keys[keys.length - 1]`: these timestamps exceed
    // 2^32, so they do not qualify for JS's special ascending-integer key
    // order, and a plain object's key order is otherwise just insertion
    // order - not guaranteed to already be sorted.
    const lastKey = keys.reduce((max, k) => (Number(k) > Number(max) ? k : max), keys[0])
    cursor = Number(lastKey) + 1
  }
}

const numOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
