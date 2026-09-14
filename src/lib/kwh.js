// kWh's own historical view, distinct from the chart/table panel the rest of
// the tags share (see App.jsx and hooks/useSeriesHistory.js). That panel
// reads minute rollups, and kWh - a cumulative meter pushed roughly every 12
// hours - has none: a tag reporting slower than once a minute can never put
// two samples in the same minute bucket (useSeriesHistory's usesRawOnly), so
// its history lives only under history/kWh/raw/, one bare number per push.
//
// At that cadence the volume concerns that shaped Current/Voltage's raw view
// (paginated backfill, a 3-day retention ceiling) do not apply: a full year
// is on the order of 700 rows. Ranges here are chosen for what is useful to
// look back over on a meter, not for what is cheap to fetch.

import { DAY, MINUTE } from './time'

// The exact RTDB key this device publishes the meter under - not a display
// name, which is why this lives beside the range/row logic rather than in
// lib/tags.js: nothing else needs to know kWh's key specifically, only the
// history view built around it.
export const KWH_TAG_KEY = 'kWh'

// `ms: null` marks "all time" - there is no cutoff to compute, the query
// simply reads the whole node (see useKwhHistory).
export const KWH_RANGES = [
  { id: 'kwh-7d', label: '7 days', ms: 7 * DAY },
  { id: 'kwh-30d', label: '30 days', ms: 30 * DAY },
  { id: 'kwh-90d', label: '90 days', ms: 90 * DAY },
  { id: 'kwh-all', label: 'All time', ms: null },
]

export const DEFAULT_KWH_RANGE = KWH_RANGES[0]

export const kwhRangeById = (id) => KWH_RANGES.find((r) => r.id === id) || DEFAULT_KWH_RANGE

/**
 * Raw meter readings (ascending, `{ t, value }`) turned into rows carrying
 * the consumption *since the previous reading* - the number that actually
 * answers "how much did we use", which the bare running total does not.
 *
 * `readings` may include one entry from before `since`, purely so the first
 * in-window row's delta is computed against a real prior reading instead of
 * showing none at all (see useKwhHistory, which is what fetches that extra
 * context row) - `since` is what tells this function to use it for that one
 * subtraction without turning it into a row of its own. Pass `since: null`
 * (the "all time" range, which has no such context row to begin with) to
 * turn every reading into a row.
 *
 * Deltas are computed from the actual gap between adjacent stored
 * timestamps, never assumed to be ~12h apart: the device also pushes on
 * startup, so a reboot can put two readings much closer together.
 *
 * A meter only ever counts up. A reading lower than the one before it means
 * the counter was reset or the meter replaced, not that consumption went
 * negative - so that row is flagged an anomaly, with no delta figure, rather
 * than a negative number that would silently corrupt a total.
 */
export function buildKwhRows(readings, since) {
  const rows = []

  for (let i = 0; i < readings.length; i++) {
    const cur = readings[i]
    if (since != null && cur.t < since) continue // context row only, not displayed

    const prev = readings[i - 1] || null
    const deltaMs = prev ? cur.t - prev.t : null
    const rawDelta = prev ? cur.value - prev.value : null
    const anomaly = rawDelta != null && rawDelta < 0

    rows.push({
      t: cur.t,
      value: cur.value,
      deltaMs,
      delta: anomaly ? null : rawDelta,
      anomaly,
    })
  }

  return rows
}

/**
 * Total consumption across `rows`. An anomalous row contributes nothing -
 * not a negative number - so one meter reset does not understate everything
 * else in the range.
 */
export function kwhTotal(rows) {
  return rows.reduce((sum, r) => (r.delta != null ? sum + r.delta : sum), 0)
}

/** The actual span between two readings - "6h 15m", "2d 4h", "42m" - never
 * a flat "12h", since a reboot or two close pushes can make it much shorter. */
export function formatKwhSpan(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < MINUTE) return '<1m'

  const totalMinutes = Math.round(ms / MINUTE)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60

  if (days) return hours ? `${days}d ${hours}h` : `${days}d`
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/**
 * A reading or a delta, as a plain fixed-point number - never the scientific
 * notation lib/tags.js's formatValue falls back to under 0.01. That branch
 * exists for physical readings like Current, where a small value is still
 * one worth seeing precisely; a kWh delta that small is noise on a meter
 * this coarse (two pushes a day), and reads better as "0.00" than "2.00e-3".
 */
export function formatKwhAmount(value) {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  return abs >= 1000 ? value.toFixed(1) : value.toFixed(2)
}
