// Deciding whether what is on screen may be trusted as current.
//
// The failure this guards against: the plant stops, the numbers freeze, and the
// dashboard keeps presenting the last good reading as though it were live.
// Every value shown must carry its own state, and stale must be impossible to
// mistake for live.

import { SECOND, MINUTE, HOUR } from './time'

export const DEFAULT_PERIOD_MS = 5 * SECOND // brief's nominal, used only until observed
const STALE_MULTIPLE = 6                    // ~6 missed publishes before doubting
const MIN_THRESHOLD = 15 * SECOND
const MAX_THRESHOLD = 5 * MINUTE

// Per-tag bounds are wider than the device's. The device cadence is always
// fast - a few seconds - so 5 minutes is already a generous multiple of it.
// A tag's own interval can legitimately be a 12-hour energy accumulator, and
// clamping that to 5 minutes would flag it as stale the moment it finishes
// publishing. The floor stays the same 15s: a sub-second tag jittering by a
// few hundred ms is not a fault either way.
const TAG_MIN_THRESHOLD = 15 * SECOND
const TAG_MAX_THRESHOLD = 48 * HOUR

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
 * How old a *tag's* own last reading may get before it stops counting as
 * current - the same "a few missed publishes, clamped" rule as the device
 * banner, but keyed to that tag's own configured interval instead of the
 * device-wide one.
 *
 * This is what makes a 12-hour accumulator and a one-second sensor coexist on
 * the same grid: each is only ever judged against its own schedule. A tag
 * with no interval reported falls back to the same nominal default the device
 * banner uses before it has observed a real cadence - treating "unknown" as
 * "assume fast" is the safer of the two wrong guesses, since it flags a quiet
 * tag sooner rather than hiding a real outage behind an unearned pass.
 */
export function tagStalenessThreshold(intervalMs) {
  const interval = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : DEFAULT_PERIOD_MS
  return Math.min(TAG_MAX_THRESHOLD, Math.max(TAG_MIN_THRESHOLD, interval * STALE_MULTIPLE))
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
