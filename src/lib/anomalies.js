// Marking which already-loaded history points are worth a second look - a
// hard limit breach, or failing that, a statistical spike against the tag's
// own recent trend. Both functions below work only from rows the chart or
// table already fetched for display; neither reads anything new from
// Firebase, which matters on a page whose whole history layer (see
// useSeriesHistory) is built around not re-downloading what is already on
// screen.
//
// Two variants because the table and the chart hold history in different
// shapes. The table (lib/table.js) walks the *unaggregated* rollup/raw rows
// straight from useSeriesHistory, one real timestamp per row, so a breach
// test there can use that row's own min/max envelope - the most sensitive
// check available. The chart draws `mergeSeries`'s downsampled buckets
// instead, where several source rows can fold into one plotted point; there,
// only a single series still carries a per-bucket min/max (see
// lib/series.js), so a multi-tag chart falls back to judging the bucket's
// mean.

import { isSpike } from './alerts'

const WINDOW = 20

const numericTag = (tag) => tag.dataType !== 'bool' && tag.dataType !== 'text'

/** Anomaly kind at each timestamp in `rows` ({t,min,avg,max}), for the table. */
export function flagTableAnomalies(rows, tag) {
  const flags = new Map()
  if (!numericTag(tag)) return flags

  const buffer = []
  for (const r of rows || []) {
    const avg = r.avg
    if (typeof avg !== 'number' || !Number.isFinite(avg)) continue

    const hi = typeof r.max === 'number' ? r.max : avg
    const lo = typeof r.min === 'number' ? r.min : avg

    const breached = tag.hiLimit != null && hi > tag.hiLimit
      ? 'breach-hi'
      : tag.loLimit != null && lo < tag.loLimit ? 'breach-lo' : null

    if (breached) flags.set(r.t, breached)
    else if (isSpike(buffer, avg)) flags.set(r.t, 'spike')

    // A breached reading is known-bad, not "recent normal" - folding it into
    // the baseline would let one hard excursion raise the bar so far that a
    // genuine spike right after it goes unnoticed (tested: an outlier at
    // minute 30 silently absorbed a real spike at minute 50 until this was
    // excluded).
    if (!breached) {
      buffer.push(avg)
      if (buffer.length > WINDOW) buffer.shift()
    }
  }
  return flags
}

/** Anomaly kind at each plotted point in `mergedRows` (see lib/series.js), for the chart. */
export function flagChartAnomalies(mergedRows, tag, hasEnvelope) {
  const flags = new Map()
  if (!numericTag(tag)) return flags

  const buffer = []
  for (const row of mergedRows) {
    const mean = row.raw?.[tag.key]
    if (typeof mean !== 'number' || !Number.isFinite(mean)) continue

    const hi = hasEnvelope && typeof row.max === 'number' ? row.max : mean
    const lo = hasEnvelope && typeof row.min === 'number' ? row.min : mean

    const breached = tag.hiLimit != null && hi > tag.hiLimit
      ? 'breach-hi'
      : tag.loLimit != null && lo < tag.loLimit ? 'breach-lo' : null

    if (breached) flags.set(row.t, breached)
    else if (isSpike(buffer, mean)) flags.set(row.t, 'spike')

    if (!breached) {
      buffer.push(mean)
      if (buffer.length > WINDOW) buffer.shift()
    }
  }
  return flags
}
