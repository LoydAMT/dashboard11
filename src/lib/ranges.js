import { HOUR, DAY, MINUTE } from './time'

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

export const rangeById = (id) => RANGES.find((r) => r.id === id) || DEFAULT_RANGE

/** Nominal spacing of a downsampled series, used for gap detection. */
export function expectedStep(range, rowCount) {
  const buckets = Math.min(rowCount || 1, range.points)
  return Math.max(MINUTE, Math.round(range.ms / Math.max(buckets, 1)))
}
