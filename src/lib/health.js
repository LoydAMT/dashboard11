// Deciding whether what is on screen may be trusted as current.
//
// The failure this guards against: the plant stops, the numbers freeze, and the
// dashboard keeps presenting the last good reading as though it were live.
// Every value shown must carry its own state, and stale must be impossible to
// mistake for live.

import { SECOND, MINUTE } from './time'

export const DEFAULT_PERIOD_MS = 5 * SECOND // brief's nominal, used only until observed
const STALE_MULTIPLE = 6                    // ~6 missed publishes before doubting
const MIN_THRESHOLD = 15 * SECOND
const MAX_THRESHOLD = 5 * MINUTE

/**
 * How old `lastSeen` may get before values stop counting as current.
 *
 * Derived from the observed publish cadence rather than a hardcoded 30s,
 * because the brief warns the 5s interval may change. If the pusher slows to
 * one write a minute, a fixed 30s threshold would paint a healthy plant red
 * forever; if it speeds up, that threshold would hide a real outage for far
 * too long. Clamped at both ends so a burst or a long pause cannot produce a
 * nonsensical window.
 */
export function stalenessThreshold(observedPeriodMs) {
  const period = observedPeriodMs > 0 ? observedPeriodMs : DEFAULT_PERIOD_MS
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, period * STALE_MULTIPLE))
}

/**
 * The three states from the brief, plus the two honest "we don't know yet"
 * cases. Order matters: a broken link to Firebase outranks anything the data
 * appears to say, because in that case the data is simply old by definition.
 *
 * @returns {{ level, ageMs, thresholdMs, detail }}
 *   level: 'connecting' | 'disconnected' | 'no-data' | 'stale' | 'live'
 */
export function systemState({ connected, status, nowMs, thresholdMs, authReady }) {
  if (!authReady) {
    return { level: 'connecting', ageMs: null, thresholdMs, detail: 'Signing in' }
  }

  if (connected === false) {
    return {
      level: 'disconnected',
      ageMs: null,
      thresholdMs,
      detail: 'No connection to Firebase. Nothing on this screen is being updated.',
    }
  }

  if (connected == null) {
    return { level: 'connecting', ageMs: null, thresholdMs, detail: 'Connecting' }
  }

  const lastSeen = typeof status?.lastSeen === 'number' ? status.lastSeen : null
  if (lastSeen == null) {
    return {
      level: 'no-data',
      ageMs: null,
      thresholdMs,
      detail: 'Connected, but the logger has never reported.',
    }
  }

  // Guard against a viewer clock running behind the pusher's: a slightly
  // negative age is skew, not freshness to celebrate, but it is not staleness.
  const ageMs = Math.max(0, nowMs - lastSeen)

  // `online` is the pusher's own claim. Trust it to say "down", never to say
  // "up" — if the pusher died mid-write the flag stays true forever, and only
  // the age of lastSeen reveals it.
  if (status?.online === false) {
    return { level: 'stale', ageMs, thresholdMs, detail: 'The logger reported itself offline.' }
  }

  if (ageMs > thresholdMs) {
    return { level: 'stale', ageMs, thresholdMs, detail: 'No new data from the logger.' }
  }

  return { level: 'live', ageMs, thresholdMs, detail: 'Receiving data.' }
}

/** True when values must be rendered as not-current. */
export const isStaleLevel = (level) =>
  level === 'stale' || level === 'disconnected' || level === 'no-data'
