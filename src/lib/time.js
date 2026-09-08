// Everything crossing the wire is epoch milliseconds, UTC. Conversion to the
// viewer's local zone happens here and nowhere else.

export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Coarse "how long ago", tuned for glancing at a phone. */
export function formatAgo(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'never'
  if (ms < 0) return 'just now' // small clock skew between pusher and viewer
  if (ms < 10 * SECOND) return 'just now'
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s ago`
  if (ms < HOUR) {
    const m = Math.floor(ms / MINUTE)
    return `${m} minute${m === 1 ? '' : 's'} ago`
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR)
    return `${h} hour${h === 1 ? '' : 's'} ago`
  }
  const d = Math.floor(ms / DAY)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

/** Absolute local time, shown alongside the relative one so there is no doubt. */
export function formatLocal(epochMs) {
  if (epochMs == null || !Number.isFinite(epochMs)) return '—'
  return new Date(epochMs).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

/** Axis tick label. Long ranges need the date, short ones only the clock. */
export function formatAxisTime(epochMs, rangeMs) {
  const d = new Date(epochMs)
  if (rangeMs > 2 * DAY) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  if (rangeMs > 12 * HOUR) {
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export const floorToMinute = (epochMs) => Math.floor(epochMs / MINUTE) * MINUTE
