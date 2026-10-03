// Alert records and the spike test they share with lib/anomalies.js.
//
// An alert is {id, ts, kind, tagKey, tagName, message, level}.
//   kind:  'alarm-high' | 'alarm-low' | 'alarm-clear' | 'disconnected'
//        | 'reconnected' | 'spike'
//   level: 'critical' | 'warning' | 'info' - drives toast/log colour and how
//          long a toast stays up before it self-dismisses.
//
// The log is kept in localStorage, one entry per device, so a shift can
// review what happened after a toast has already faded - nothing here is
// written back to Firebase; this is a viewer-side notebook, not telemetry.

const LOG_KEY_PREFIX = 'rhw-alerts:'
const LOG_LIMIT = 300

export function loadLog(deviceId) {
  if (!deviceId) return []
  try {
    const raw = localStorage.getItem(LOG_KEY_PREFIX + deviceId)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveLog(deviceId, entries) {
  if (!deviceId) return
  try {
    localStorage.setItem(LOG_KEY_PREFIX + deviceId, JSON.stringify(entries.slice(-LOG_LIMIT)))
  } catch {
    // Storage full or unavailable: toasts for this session still work, only
    // the persisted history is lost.
  }
}

let seq = 0
export function makeAlert({ kind, tagKey = null, tagName = null, message, level, ts = Date.now() }) {
  seq += 1
  return { id: `${ts}-${seq}`, ts, kind, tagKey, tagName, message, level }
}

// A window shorter than this has no established baseline yet - without the
// floor, a tag's first few readings would all qualify as "far from an empty
// average". Z_THRESHOLD is deliberately conservative (a plain 2-3 sigma test
// fires constantly on ordinary process noise); MIN_DELTA_FRACTION is the
// fallback for a near-constant tag, where sd is close to zero and any
// z-score test alone would flag a one-part-in-a-thousand wobble as infinite
// standard deviations away.
const MIN_SAMPLES = 8
const Z_THRESHOLD = 4
const MIN_DELTA_FRACTION = 0.02

// A move smaller than this many of the tag's own publish steps (its
// `deadband`, from tags/) is not a spike. Mirrors SPIKE_DEADBAND_STEPS in
// functions/alertEngine.js, so the bell and the server record agree.
//
// A box with a deadband republishes an unchanged value on its heartbeat, so
// a steady tag fills this buffer with identical readings: sd is exactly 0.
// The next real tick - Free Chlorine going 0.42 -> 0.44 ppm - was then 4.7%
// off a perfectly flat mean and passed every test above. That is the sensor
// moving one step, not an event.
export const SPIKE_DEADBAND_STEPS = 3

/** The absolute spike floor for a tag, or 0 when its box publishes no deadband. */
export const spikeFloorFor = (tag) =>
  (typeof tag?.deadband === 'number' && tag.deadband > 0 ? tag.deadband * SPIKE_DEADBAND_STEPS : 0)

/**
 * Is `value` a spike against the trailing `buffer` (oldest first, `value` not
 * yet included)? `minDelta` is an absolute floor in the tag's units; 0 = none.
 */
export function isSpike(buffer, value, minDelta = 0) {
  if (buffer.length < MIN_SAMPLES) return false
  const mean = buffer.reduce((a, b) => a + b, 0) / buffer.length
  const variance = buffer.reduce((a, b) => a + (b - mean) ** 2, 0) / buffer.length
  const sd = Math.sqrt(variance)
  const delta = Math.abs(value - mean)
  const floor = Math.max(sd * Z_THRESHOLD, Math.abs(mean) * MIN_DELTA_FRACTION, minDelta, 1e-9)
  return delta > floor
}
