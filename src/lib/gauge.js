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
// A tag with no thresholds still gets a gauge, centred on the mean of its
// recent readings, with the ends at the point where the SPIKE DETECTOR would
// fire (src/lib/alerts.js). So the ends always mean the same thing: "the
// system would raise something about this reading". For a ruled tag that is
// the threshold you set; for an unruled one it is a spike. Nothing on the
// gauge is invented - both boundaries are real alarm boundaries.

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
export function gaugeScale({ value, lo = null, hi = null, samples = [] }) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v)
  const usable = samples.filter(num)
  const hasLo = num(lo)
  const hasHi = num(hi)
  const stats = usable.length >= MIN_SAMPLES ? spread(usable) : null

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

  const min = centre - halfWidth
  const max = centre + halfWidth
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
    // Zone edges as fractions. A threshold that was configured lands on
    // exactly 0.1 / 0.9 by construction; an inferred scale gets both.
    loStop: hasLo || inferred ? 0.1 : null,
    hiStop: hasHi || inferred ? 0.9 : null,
    loValue: hasLo ? lo : inferred ? min + (max - min) * 0.1 : null,
    hiValue: hasHi ? hi : inferred ? min + (max - min) * 0.9 : null,
    // `inferred` drives the muted styling: these ends are "unusual for this
    // tag", not "past a number a person chose". Presenting a guess in the
    // same red as a real threshold would be a lie about where it came from.
    inferred,
  }
}
