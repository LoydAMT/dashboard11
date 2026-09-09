import { HOUR, DAY, MINUTE, SECOND } from './time'

// Selectable history windows. `points` is the render budget for each — a phone
// showing sevenee days does not benefit from more resolution than this, and every
// point is billsdasded bandwidth.
export const RANGES = [
  { id: '1h', label: '1h', ms: HOUR, points: 240 },
  { id: '6h', label: '6h', ms: 6 * HOUR, points: 360 },
  { id: '24h', label: '24h', ms: DAY, points: 480 },
  { id: '7d', label: '7d', ms: 7 * DAY, points: 600 },
]

export const DEFAULT_RANGE = RANGES[1] // 6h

// A different kind of window, not a fifth entry in the list above. These read
// history/{tag}/raw/ - one row per actual device push - rather than a minute
// rollup, and raw rows do not compress the way a rollup does: a 7-day raw
// window would mean pulling and rendering tens of thousands of individual
// points for no benefit a rollup would not already give more cheaply. Kept
// deliberately short, and kept in a separate list so a rollup range can never
// collide with a raw one by id or by having the same `ms` (see the note on
// `bucketFloorMs` below, and useSeriesHistory's cache key).
//
// `bucketFloorMs` overrides the 1-minute floor mergeSeries otherwise applies —
// without it, a 5-minute chart would still get binned into 1-minute buckets,
// which is most of the detail raw mode exists to show.
export const RAW_RANGES = [
  { id: 'raw-5m', label: 'Last 5 min', ms: 5 * MINUTE, points: 300, bucketFloorMs: SECOND, raw: true },
  { id: 'raw-15m', label: 'Last 15 min', ms: 15 * MINUTE, points: 450, bucketFloorMs: SECOND, raw: true },
  { id: 'raw-1h', label: 'Last 1h', ms: HOUR, points: 600, bucketFloorMs: SECOND, raw: true },
]

export const isRawRange = (range) => Boolean(range?.raw)

export const rangeById = (id) =>
  RANGES.find((r) => r.id === id) || RAW_RANGES.find((r) => r.id === id) || DEFAULT_RANGE

/** Nominal spacing of a downsampled series, used for gap detection. */
export function expectedStep(range, rowCount) {
  const buckets = Math.min(rowCount || 1, range.points)
  return Math.max(MINUTE, Math.round(range.ms / Math.max(buckets, 1)))
}
