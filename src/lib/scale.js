// Display scaling for tags the device publishes as fixed-point integers.
//
// A tag arrives as 8 and means 0.8. The divisor is applied here, on the way to
// the screen, and nowhere else: SQLite and RTDB keep the raw counts the panel
// sent, so the historian stays a faithful record of the wire and any future
// correction to this factor is one line, not a migration.
//
// Scaling on read rather than on write is the deliberate part. Dividing in
// rh_logger.py would leave every row written before the edit at the old
// magnitude, and the trend would then show a step change at that moment which
// no process ever performed. Applied here, the whole window renders in one
// unit, history included.
//
// Divisors rather than multipliers: `v / 10` is exact for many more values
// than `v * 0.1`, which turns 3 into 0.30000000000000004.

// ---------------------------------------------------------------------------
// THE KNOB. Change this one number to rescale every numeric tag at once.
//
// 10 means the device publishes tenths: 8 on the wire is 0.8 on the screen.
// Set it to 1 to show raw counts again.
// ---------------------------------------------------------------------------
export const DEFAULT_DIVISOR = 10

/**
 * Per-tag exceptions, for when one tag disagrees with the default.
 *
 * Keyed by RTDB key — the sanitised name, so 'd/Test1' is stored as 'd_Test1'.
 * An entry here wins over DEFAULT_DIVISOR; a tag with no entry takes the
 * default. Set a tag to 1 to leave it unscaled.
 *
 *   export const DIVISORS = { d_Pressure: 100, d_Counter: 1 }
 */
export const DIVISORS = {}

// `??`, not `||`: an override of 1 means "do not scale this one" and must not
// fall through to the default the way a falsy value would.
export const divisorFor = (key) => DIVISORS[key] ?? DEFAULT_DIVISOR

/** Non-numbers and nulls pass through untouched, so callers need no guard. */
export function scaleValue(v, divisor) {
  if (divisor === 1) return v
  return typeof v === 'number' && Number.isFinite(v) ? v / divisor : v
}

/** Label for the badge that tells the reader the screen is not showing raw counts. */
export const divisorLabel = (divisor) => (divisor === 1 ? null : `÷${divisor}`)
