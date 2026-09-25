// Gauge scale for a tag card.
//
// THE RULE THE SCALE OBEYS: the alert zones are ALWAYS the first and last
// 10% of the sweep. The numbers under them change per tag; the shape does
// not. That is the whole point - once you have learned that "needle near the
// end is bad", you can read any card on the wall at a glance without first
// reading its axis.
//
// Everything below is expressed as a CENTRE plus a HALF-WIDTH, because that
// single form covers all four cases (both thresholds, one threshold, none)
// and keeps the 10%/90% guarantee arithmetic in exactly one place.
//
// WHERE THE SCALE COMES FROM WHEN NOTHING IS CONFIGURED
// A tag with no thresholds still gets a dial, spanning the range it has
// actually been seen in recently. That scale carries NO coloured zones -
// nothing on it is a level anyone chose, and drawing one would be a lie
// about where it came from. The tile says "no alerts set" in words instead.

// Mirrors src/lib/alerts.js. Kept as its own copy rather than imported so
// the gauge cannot silently change shape if the spike test is ever tuned for
// detection reasons that have nothing to do with drawing.
const Z_THRESHOLD = 4
const MIN_DELTA_FRACTION = 0.02
const MIN_SAMPLES = 8

/** Mean and spike-boundary distance for a sample buffer. */
export function spread(samples) {
  const n = samples.length
  const mean = samples.reduce((a, b) => a + b, 0) / n
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  const sd = Math.sqrt(variance)
  // The same floor the spike test uses, so the gauge ends sit exactly where
  // a spike would be called - including the near-constant-tag fallback,
  // without which a perfectly steady reading would collapse the gauge to a
  // single point.
  return { mean, halfWidth: Math.max(sd * Z_THRESHOLD, Math.abs(mean) * MIN_DELTA_FRACTION, 1e-9) }
}

/**
 * @param value    the current reading (number, or null when there is none)
 * @param lo/hi    configured alert thresholds, or null
 * @param samples  recent readings, oldest first
 *
 * Returns null when there is nothing honest to draw - no thresholds AND too
 * few samples to infer a scale from. An accumulator read once a day (kWh)
 * lands here, which is correct: a gauge implies a range to sit inside, and a
 * meter total has none.
 */
export function gaugeScale({ value, lo = null, hi = null, samples = [], range = null }) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v)
  const usable = samples.filter(num)
  const hasLo = num(lo)
  const hasHi = num(hi)
  // `range` lets a caller supply an OBSERVED min..max instead of the
  // readings it came from. The mall page needs this - it shows ninety
  // tenants at once and cannot hold ninety sample buffers - and it is also
  // more honest than a statistical band.
  //
  // WHY OBSERVED EXTREMES AND NOT 4 SIGMA: the first version derived the
  // band from the standard deviation of MINUTE AVERAGES and then put an
  // INSTANTANEOUS reading on it. Averaging smooths variance away, so the
  // band came out far narrower than the live value's real swing and the
  // needle sat pinned to one end with an off-scale arrow most of the time.
  // A dial whose needle is usually off the dial is worse than no dial.
  const observed = (range && num(range.min) && num(range.max) && range.max > range.min)
    ? range
    : null
  const stats = observed
    ? { mean: (observed.min + observed.max) / 2, halfWidth: (observed.max - observed.min) / 2 }
    : (usable.length >= MIN_SAMPLES ? spread(usable) : null)

  let centre
  let halfWidth
  let inferred = false

  if (hasLo && hasHi && hi > lo) {
    // lo at 10%, hi at 90%: they span 80% of the sweep, so the full sweep is
    // that span divided by 0.8, and the centre sits midway between them.
    centre = (lo + hi) / 2
    halfWidth = (hi - lo) / 2 / 0.8
  } else if (hasHi || hasLo) {
    // One threshold. It still lands on its 10%/90% mark; the opposite end is
    // wherever the readings actually live, because there is no second number
    // to derive it from.
    const bound = hasHi ? hi : lo
    centre = stats ? stats.mean : bound * (hasHi ? 0.5 : 1.5)
    // The mark sits 40 percentage points from the centre (50% -> 90% or 10%),
    // and halfWidth spans 50 of them - so the distance from centre to the
    // mark is 0.8 of halfWidth, not 0.4. Floored so a reading already sitting
    // on its threshold cannot collapse the sweep to zero and divide by it.
    halfWidth = Math.max(
      Math.abs(bound - centre) / 0.8,
      stats ? stats.halfWidth : 0,
      Math.abs(bound) * 1e-3,
      1e-9,
    )
    // Keep the threshold on its mark even when the floor above widened the
    // sweep, by recentring rather than letting the mark drift.
    centre = hasHi ? bound - halfWidth * 0.8 : bound + halfWidth * 0.8
  } else if (stats) {
    centre = stats.mean
    halfWidth = stats.halfWidth
    inferred = true
  } else {
    return null
  }

  let min = centre - halfWidth
  let max = centre + halfWidth

  // A tag with only a HIGH threshold has no meaningful bottom end, and
  // centring it on recent readings pushes the scale below zero - which
  // matters now that the axis is labelled: "-4.85 A" on a current dial is
  // not a quantity, it is an artefact. When nothing has ever gone negative,
  // zero is the honest floor. hi stays on its 90% mark either way, so the
  // guarantee the whole gauge rests on is untouched.
  if (hasHi && !hasLo && min < 0 && hi > 0) {
    const everNegative = usable.some((v) => v < 0) || (num(value) && value < 0)
    if (!everNegative) {
      min = 0
      max = hi / 0.9
    }
  }

  const at = (v) => (v - min) / (max - min)

  return {
    min,
    max,
    // Fraction of the sweep, clamped so a reading far outside its range
    // pins the needle to the end instead of drawing off the arc. The
    // printed number on the card is never clamped, so the real value is
    // always legible even when the needle has run out of room.
    pct: num(value) ? Math.min(1, Math.max(0, at(value))) : null,
    offScale: num(value) ? (at(value) < 0 ? 'low' : at(value) > 1 ? 'high' : null) : null,
    // Zone edges as fractions, landing on exactly 0.1 / 0.9 by
    // construction. NO zones on an inferred scale. They would be grey stubs at each end
    // that look exactly like the real thing but mark nothing anyone chose -
    // the first version drew them and they read as smudges on the arc. An
    // unruled tag shows its recent range and its needle, and the tile says
    // "no alerts set" in words.
    loStop: hasLo ? 0.1 : null,
    hiStop: hasHi ? 0.9 : null,
    loValue: hasLo ? lo : null,
    hiValue: hasHi ? hi : null,
    // Tells the caller this scale describes recent behaviour rather than a
    // configured level, so it can say so.
    inferred,
    ticks: ticksFor(min, max),
  }
}

/**
 * Six evenly spaced labelled marks, rounded for reading rather than for
 * precision - the dial is for "roughly where am I", the printed number
 * underneath is for the actual value.
 *
 * The marks are spaced by POSITION, not snapped to round numbers, because
 * the ends of this scale are load-bearing: they are exactly the alert
 * thresholds. Snapping the axis would drag the coloured zones off the 10%
 * marks that make every card on the wall comparable.
 */
export function ticksFor(min, max, count = 6) {
  const span = max - min
  if (!(span > 0)) return []
  // Decimals from the span, not from each value, so the labels line up
  // instead of mixing "0" with "11.11".
  const step = span / (count - 1)
  const dp = step >= 0.5 ? 0 : step >= 0.05 ? 1 : step >= 0.005 ? 2 : 3

  const build = (n) => Array.from({ length: n }, (_, i) => {
    const pct = i / (n - 1)
    return { pct, label: (min + span * pct).toFixed(dp) }
  })

  // Six marks is the default, but a scale that needs long labels - a tight
  // range forcing decimals, or a tag reading in the hundreds of thousands -
  // crowds them into each other on a card this size. Decided on the rendered
  // WIDTH rather than on decimal places, so both causes are handled by one
  // rule. Three marks still says low / middle / high, which is all a
  // crowded axis can honestly convey anyway.
  const ticks = build(count)
  const widest = Math.max(...ticks.map((t) => t.label.length))
  return widest >= 5 ? build(3) : ticks
}
