import { useEffect, useMemo, useRef, useState } from 'react'
import { ref, query, orderByKey, startAt, limitToLast, get, onValue } from 'firebase/database'
import { db } from '../firebase'
import { floorToMinute } from '../lib/time'

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
 */
export function useSeriesHistory(keys, range, enabled = true) {
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

  const keysId = enabled ? [...new Set(keys)].filter(Boolean).join(' ') : ''

  useEffect(() => {
    const keyList = keysId ? keysId.split(' ') : []
    const wanted = new Set(keyList)

    // Close listeners for what is no longer shown, and for anything whose
    // window changed — a wider range needs a deeper backfill than the one
    // already in hand. The rows they gathered stay cached under their own
    // window key.
    for (const [key, sub] of subs.current) {
      if (!wanted.has(key) || sub.rangeMs !== range.ms) {
        sub.cancelled = true
        sub.unsubscribe()
        subs.current.delete(key)
      }
    }

    for (const key of keyList) {
      if (subs.current.has(key)) continue

      const sub = { rangeMs: range.ms, cancelled: false, unsubscribe: () => {} }
      subs.current.set(key, sub)

      const path = `history/${key}`
      const slot = `${key}@${range.ms}`
      const since = floorToMinute(Date.now() - range.ms)

      // Keyed by minuteEpoch so the backfill and the live tail merge without
      // duplicating the minute both of them see.
      const rowsByMinute = new Map()

      const absorb = (raw) => {
        if (!raw) return
        for (const [minute, v] of Object.entries(raw)) {
          const t = Number(minute)
          if (!Number.isFinite(t) || v == null) continue
          rowsByMinute.set(t, {
            t,
            min: numOr(v.min, v.avg),
            max: numOr(v.max, v.avg),
            avg: numOr(v.avg, null),
            n: typeof v.n === 'number' ? v.n : 1,
          })
        }
        const rows = [...rowsByMinute.values()].sort((a, b) => a.t - b.t)
        setStore((prev) => ({ ...prev, [slot]: { rows, error: null } }))
      }

      const fail = (error) => {
        if (sub.cancelled) return
        setStore((prev) => ({ ...prev, [slot]: { rows: [], error } }))
      }

      // 1. Backfill this tag's window.
      get(query(ref(db, path), orderByKey(), startAt(String(since))))
        .then((snap) => {
          if (sub.cancelled) return
          absorb(snap.val())
        })
        .catch(fail)

      // 2. Follow its leading edge.
      sub.unsubscribe = onValue(
        query(ref(db, path), orderByKey(), limitToLast(2)),
        (snap) => {
          if (sub.cancelled) return
          absorb(snap.val())
        },
        fail,
      )
    }

    // No cleanup returned on purpose: this effect reconciles subscriptions, it
    // does not own them. Ownership ends at unmount, handled once below.
  }, [keysId, range.ms])

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
      const entry = store[`${key}@${range.ms}`]
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
  }, [keysId, store, range.ms])
}

const numOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
