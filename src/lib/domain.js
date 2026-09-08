// The value axis for the trend chart, kept out of the component so it can be
// tested directly: a wrong domain is invisible in code review and glaring on
// screen.

/**
 * Pad the value axis, round it to a readable step, and keep configured limits
 * in frame so a breach is visible.
 *
 * The rounding is not cosmetic. Left on raw data bounds, the axis ticks come
 * out as full-precision floats — 0.19755604068… — which are far too long for
 * the axis gutter. Right-aligned text overflows to the left and gets clipped,
 * so what reaches the screen is the *tail* of the number: a column of
 * meaningless 7-digit strings, several of them identical because evenly spaced
 * ticks share a fractional tail. Snapping the domain to a 1/2/5 step puts the
 * ticks on round numbers; `axisTickFormatter` then keeps them short.
 */
export function computeDomain(rows, tags, { isBool, indexed }) {
  if (indexed) return [0, 100]
  if (isBool) return [0, 1]

  let lo = Infinity
  let hi = -Infinity

  for (const row of rows) {
    // The band widens the frame for a lone series; for an overlay the lines
    // themselves are the extent.
    if (Array.isArray(row.band)) {
      if (row.band[0] < lo) lo = row.band[0]
      if (row.band[1] > hi) hi = row.band[1]
    }
    for (const tag of tags) {
      const v = row[tag.key]
      if (typeof v !== 'number') continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }

  if (lo === Infinity) return ['auto', 'auto']

  if (tags.length === 1) {
    if (tags[0].loLimit != null) lo = Math.min(lo, tags[0].loLimit)
    if (tags[0].hiLimit != null) hi = Math.max(hi, tags[0].hiLimit)
  }

  // A dead-flat series would otherwise collapse to a zero-height axis.
  const span = hi - lo || Math.max(Math.abs(hi) * 0.1, 1)
  const pad = span * 0.08
  const step = niceStep((span + 2 * pad) / 4)

  return [
    Math.floor((lo - pad) / step) * step,
    Math.ceil((hi + pad) / step) * step,
  ]
}

/**
 * The 1 / 2 / 5 × 10^n step nearest `rough`.
 *
 * Nearest, not nearest-below: rounding 0.0176 down to 0.01 puts eight ticks on
 * the axis where five would do, and rounding it to 0.02 lands them on 0.18,
 * 0.20, 0.22 instead of 0.1975, 0.215.
 */
function niceStep(rough) {
  if (!Number.isFinite(rough) || rough <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const scaled = rough / magnitude
  const nice = scaled < 1.5 ? 1 : scaled < 3 ? 2 : scaled < 7 ? 5 : 10
  return nice * magnitude
}

/**
 * Explicit tick positions on the step the domain was snapped to.
 *
 * Left to itself, Recharts divides the given domain into equal parts, which
 * lands ticks between the round numbers the snapping just produced. Handing it
 * the positions keeps every label short.
 */
export function axisTicks([lo, hi]) {
  if (typeof lo !== 'number' || typeof hi !== 'number' || !(hi > lo)) return undefined

  const step = niceStep((hi - lo) / 4)
  const count = Math.round((hi - lo) / step)
  // Defensive: a pathological span should fall back to Recharts' own ticks
  // rather than produce thousands of them.
  if (!Number.isFinite(count) || count < 1 || count > 12) return undefined

  // Accumulating `lo + i * step` in floating point drifts (0.19999999997); one
  // rounding at the step's own precision keeps the values exact enough to print.
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1)
  return Array.from({ length: count + 1 }, (_, i) => Number((lo + i * step).toFixed(decimals)))
}

/**
 * Tick labels short enough to fit the gutter.
 *
 * Precision follows the span, not the magnitude: a range of 0.18-0.24 needs
 * three decimals to distinguish its ticks, while 0-2000 needs none. Large
 * values go compact ("5.6M") rather than eating the whole gutter — and the
 * snapped domain above means these are already round numbers, so the rounding
 * here never hides a digit that mattered.
 */
export function axisTickFormatter([lo, hi]) {
  if (typeof lo !== 'number' || typeof hi !== 'number') return undefined

  const span = Math.abs(hi - lo) || Math.abs(hi) || 1
  const decimals =
    span >= 100 ? 0
      : span >= 10 ? 1
        : span >= 1 ? 2
          : span >= 0.1 ? 3
            : span >= 0.01 ? 4
              : 5

  return (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return ''
    if (Math.abs(v) >= 10000) {
      return new Intl.NumberFormat(undefined, {
        notation: 'compact', maximumFractionDigits: 1,
      }).format(v)
    }
    // Trailing zeros carry no information on an axis; 0.180 reads as 0.18.
    return String(Number(v.toFixed(decimals)))
  }
}
