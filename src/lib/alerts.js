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

/** Is `value` a spike against the trailing `buffer` (oldest first, `value` not yet included)? */
export function isSpike(buffer, value) {
  if (buffer.length < MIN_SAMPLES) return false
  const mean = buffer.reduce((a, b) => a + b, 0) / buffer.length
  const variance = buffer.reduce((a, b) => a + (b - mean) ** 2, 0) / buffer.length
  const sd = Math.sqrt(variance)
  const delta = Math.abs(value - mean)
  const floor = Math.max(sd * Z_THRESHOLD, Math.abs(mean) * MIN_DELTA_FRACTION, 1e-9)
  return delta > floor
}
