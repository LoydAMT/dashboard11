// History arrives as one-minute rollups. Seven days of those is 10,080 points
// per tag — more than any screen can show and more than a phone should draw.
// These helpers reduce the series for rendering without lying about it.

/**
 * Reduce to at most `target` buckets, keeping the min/max envelope.
 *
 * Averaging alone would erase exactly what an operator is looking for: the
 * brief excursion. Each output bucket therefore carries the true min and max of
 * everything it absorbed, and the chart draws that as a band behind the mean.
 *
 * @param rows sorted [{ t, min, avg, max, n }]
 */
export function downsample(rows, target = 400) {
  if (rows.length <= target) return rows

  const groupSize = Math.ceil(rows.length / target)
  const out = []

  for (let i = 0; i < rows.length; i += groupSize) {
    const group = rows.slice(i, i + groupSize)

    let min = Infinity
    let max = -Infinity
    let weighted = 0
    let n = 0

    for (const r of group) {
      if (r.min < min) min = r.min
      if (r.max > max) max = r.max
      // Weight by sample count so a minute with 12 readings does not carry the
      // same influence as one with 2.
      const w = r.n || 1
      weighted += r.avg * w
      n += w
    }

    out.push({
      t: group[0].t,
      min: min === Infinity ? null : min,
      max: max === -Infinity ? null : max,
      avg: n ? weighted / n : null,
      n,
    })
  }

  return out
}

/**
 * Break the line wherever data is missing.
 *
 * Recharts joins consecutive points with a straight segment. Across a logger
 * outage that segment is fiction — it draws a smooth interpolation over hours
 * when nothing was recorded. Inserting an explicit null forces a visible gap.
 */
export function insertGaps(rows, expectedStepMs) {
  if (rows.length < 2) return rows

  const threshold = expectedStepMs * 1.75
  const out = [rows[0]]

  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].t - rows[i - 1].t
    if (gap > threshold) {
      out.push({ t: rows[i - 1].t + Math.floor(gap / 2), avg: null, band: null, gap: true })
    }
    out.push(rows[i])
  }

  return out
}

/** Shape for Recharts: a range Area needs its bounds as a two-element array. */
export function toChartRows(rows) {
  return rows.map((r) => ({
    ...r,
    band: r.min == null || r.max == null ? null : [r.min, r.max],
  }))
}
