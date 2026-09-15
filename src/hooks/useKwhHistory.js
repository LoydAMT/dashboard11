import { useEffect, useState } from 'react'
import { ref, query, orderByKey, startAt, endAt, limitToLast, get, onValue } from 'firebase/database'
import { db } from '../firebase'

/**
 * Every raw kWh meter reading in `range`, read directly from
 * history/{deviceId}/kWh/raw - see lib/kwh.js for why this tag gets its own
 * hook instead of going through useSeriesHistory: no rollups exist for it,
 * and at roughly two pushes a day it does not need that file's pagination
 * either, so one plain query covers the whole window.
 *
 * Also fetches the single reading just before `range`, so the caller (see
 * buildKwhRows) can give the first in-window row a real delta instead of
 * none. That context reading is returned mixed into `readings`, ordered
 * ahead of everything else; it is on `buildKwhRows`, not this hook, to keep
 * it out of the rows actually displayed.
 */
export function useKwhHistory(deviceId, range, enabled) {
  const [state, setState] = useState({ readings: [], since: null, loading: true, error: null })

  useEffect(() => {
    if (!enabled || !deviceId) {
      setState({ readings: [], since: null, loading: false, error: null })
      return
    }

    let cancelled = false
    const path = `devices/${deviceId}/history/kWh/raw`
    // Captured once per (device, range) rather than recomputed by the
    // caller on every render, so "the cutoff this query actually used" and
    // "the cutoff buildKwhRows filters by" can never drift apart.
    const since = range.ms != null ? Date.now() - range.ms : null

    let context = null
    let main = {}

    const emit = () => {
      if (cancelled) return
      const readings = []
      if (context) readings.push(context)
      for (const [k, v] of Object.entries(main)) {
        const t = Number(k)
        if (!Number.isFinite(t) || typeof v !== 'number' || !Number.isFinite(v)) continue
        // Belt-and-suspenders against the tail listener below ever surfacing
        // a key older than this window - it asks for the newest couple of
        // keys in the whole node, not just the ones after `since`.
        if (since != null && t < since) continue
        readings.push({ t, value: v })
      }
      readings.sort((a, b) => a.t - b.t)
      setState({ readings, since, loading: false, error: null })
    }

    const fail = (error) => {
      if (cancelled) return
      setState((s) => ({ ...s, loading: false, error }))
    }

    setState((s) => ({ ...s, loading: true, error: null }))

    // One-shot backfill, not a listener: at roughly two pushes a day even
    // "all time" is on the order of 700 rows (see lib/kwh.js), but a bare
    // onValue here still stayed open on the *entire* window with no upper
    // bound - and on the "all time" range, no bound at all - which means
    // every reconnect re-streams every reading in range, not just whichever
    // one changed. A plain get() for the window, plus a tiny bounded tail
    // below for whatever gets pushed while this is open, is the same
    // backfill-then-follow shape useSeriesHistory already uses for every
    // other tag.
    const backfillQuery = since != null
      ? query(ref(db, path), orderByKey(), startAt(String(since)))
      : query(ref(db, path), orderByKey())

    get(backfillQuery)
      .then((snap) => {
        if (cancelled) return
        main = snap.val() || {}
        emit()
      })
      .catch(fail)

    // Live tail: the newest one or two keys in the node, however wide the
    // window is. A reading pushed while this is open still lands without a
    // reselect, at the cost of two keys instead of the whole history.
    const tailQuery = query(ref(db, path), orderByKey(), limitToLast(2))
    const unsubscribe = onValue(tailQuery, (snap) => {
      main = { ...main, ...(snap.val() || {}) }
      emit()
    }, fail)

    if (since != null) {
      // The one reading immediately before the window - a plain get(), not
      // a listener: it exists only to seed one delta, and a reading from
      // before the window ever changing after the fact is not a case that
      // needs live handling.
      get(query(ref(db, path), orderByKey(), endAt(String(since - 1)), limitToLast(1)))
        .then((snap) => {
          if (cancelled) return
          const val = snap.val()
          const entry = val && Object.entries(val)[0]
          if (entry) {
            const t = Number(entry[0])
            const v = entry[1]
            if (Number.isFinite(t) && typeof v === 'number' && Number.isFinite(v)) {
              context = { t, value: v }
            }
          }
          emit()
        })
        .catch(fail)
    }

    return () => {
      cancelled = true
      unsubscribe()
    }
    // Depends on `range` itself, not just `range.id`: both are read above,
    // and KWH_RANGES entries are stable module constants (see lib/kwh.js),
    // so this still re-runs exactly when the id would have anyway - same
    // reasoning as useSeriesHistory's identical note.
  }, [deviceId, range, enabled])

  return state
}
