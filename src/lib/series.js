// Folding several tags' one-minute rollups into the single frame Recharts draws.
//
// Each tag is downsampled onto a *shared* time grid rather than by index. Index
// grouping is what downsample.js does for a lone series, and it is right there,
// but two tags that started reporting at different times would land their group
// boundaries on different timestamps — and once the x-values disagree, every
// series acquires a null wherever another series has a point, shredding all of
// them into dashes. A grid derived from the window, not from the row count,
// keeps the series commensurable.

import { MINUTE } from './time'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * @param byKey   { [tagKey]: rows } where rows are [{ t, min, avg, max, n }]
 * @param keys    which tags to include, in draw order
 * @param indexed plot each series as 0-100% of its own window range
 */
export function mergeSeries({ byKey, keys, range, nowMs, indexed = false }) {
  const cutoff = nowMs - range.ms
  const bucketMs = Math.max(MINUTE, Math.round(range.ms / Math.max(range.points, 1)))

  const buckets = new Map()   // bucketStart -> { t, vals: Map(key -> acc) }
  const extent = new Map()    // key -> { min, max } across the whole window

  for (const key of keys) {
    const rows = byKey[key]
    if (!rows?.length) continue

    for (const r of rows) {
      if (r.t < cutoff) continue
      const avg = num(r.avg)
      if (avg == null) continue

      // A rollup missing its envelope still has a mean; treat the mean as both
      // bounds rather than dropping the point.
      const lo = num(r.min) ?? avg
      const hi = num(r.max) ?? avg
      const mid = avg

      const start = Math.floor(r.t / bucketMs) * bucketMs
      let bucket = buckets.get(start)
      if (!bucket) {
        bucket = { t: start, vals: new Map() }
        buckets.set(start, bucket)
      }

      let acc = bucket.vals.get(key)
      if (!acc) {
        acc = { sum: 0, n: 0, min: Infinity, max: -Infinity }
        bucket.vals.set(key, acc)
      }

      // Weighted by sample count, so a minute holding 12 readings does not
      // count the same as one holding 2.
      const w = r.n || 1
      acc.sum += mid * w
      acc.n += w
      if (lo < acc.min) acc.min = lo
      if (hi > acc.max) acc.max = hi

      let ext = extent.get(key)
      if (!ext) {
        ext = { min: Infinity, max: -Infinity }
        extent.set(key, ext)
      }
      if (lo < ext.min) ext.min = lo
      if (hi > ext.max) ext.max = hi
    }
  }

  const ordered = [...buckets.values()].sort((a, b) => a.t - b.t)
  const single = keys.length === 1 ? keys[0] : null

  const rows = ordered.map((bucket) => {
    // `raw` always carries the true values, so the tooltip can quote real readings
    // even while the axis is showing an index.
    const row = { t: bucket.t, raw: {} }

    for (const [key, acc] of bucket.vals) {
      const mean = acc.n ? acc.sum / acc.n : null
      if (mean == null) continue

      row.raw[key] = mean
      row[key] = indexed ? toIndex(mean, extent.get(key)) : mean

      // The min/max envelope is only drawn for a lone series. Four translucent
      // bands stacked on one axis is a smear, and the excursion the band exists
      // to reveal is exactly what gets lost in it.
      if (key === single && !indexed) {
        row.band = [acc.min, acc.max]
        row.min = acc.min
        row.max = acc.max
      }
    }

    return row
  })

  return { rows, stats: summarise(byKey, keys, cutoff), bucketMs }
}

/** 0-100% of the series' own range, so unlike magnitudes share one axis honestly. */
function toIndex(value, ext) {
  if (!ext || ext.min === Infinity) return null
  const span = ext.max - ext.min
  // A flat series has no range to sit in; park it mid-axis rather than divide
  // by zero and plot NaN.
  if (span === 0) return 50
  return ((value - ext.min) / span) * 100
}

/** Per-tag min / max / weighted mean / latest over the window. */
function summarise(byKey, keys, cutoff) {
  const out = {}

  for (const key of keys) {
    const rows = byKey[key]
    if (!rows?.length) continue

    let min = Infinity
    let max = -Infinity
    let weighted = 0
    let n = 0
    let last = null

    for (const r of rows) {
      if (r.t < cutoff) continue
      const avg = num(r.avg)
      if (avg == null) continue

      const lo = num(r.min) ?? avg
      const hi = num(r.max) ?? avg
      if (lo < min) min = lo
      if (hi > max) max = hi

      const w = r.n || 1
      weighted += avg * w
      n += w
      last = avg
    }

    if (n) {
      out[key] = {
        min: min === Infinity ? null : min,
        max: max === -Infinity ? null : max,
        avg: weighted / n,
        last,
      }
    }
  }

  return out
}
