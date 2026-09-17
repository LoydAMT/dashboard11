// Reads minute rollups that are no longer in RTDB.
//
// Once an hour has been archived to Firestore, the device deletes that
// hour's rollups from RTDB - that is the whole point of archiving, and it
// is what keeps RTDB storage from growing without bound. The cost is that
// a chart covering an older window can no longer find those rows where it
// has always looked.
//
// This is the other half: the same window, fetched from the archive, in
// the same row shape useSeriesHistory already builds from RTDB
// ({t,min,avg,max,n}), so the two merge without a translation step.
//
// It does NOT talk to Firestore directly. Firestore rules deny every
// client read on the archive, deliberately - Firestore rules cannot
// consult the RTDB viewers/operators/admins list that decides who may see
// a device, and keeping a second copy of that list in Firestore would be
// two sources of truth for one permission. So this calls a Cloud Function
// that checks the real list server-side (see functions/readArchive.js).
//
// Unconfigured is a supported state: with no VITE_ARCHIVE_API_URL set,
// every call resolves to no rows and the app behaves exactly as it did
// before the archive existed - charts just stop wherever RTDB stops.
import { auth } from '../firebase'

export const archiveConfigured = () => Boolean(import.meta.env.VITE_ARCHIVE_API_URL)

const HOUR_MS = 3600000
const hourFloor = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS

/**
 * The window to actually ask for, as opposed to the one the caller wants.
 *
 * Two different jobs here, and they happen to have the same answer.
 *
 * Correctness: the archive only ever holds hours that have closed, so asking
 * it for data up to `Date.now()` asks for something it structurally cannot
 * have. The real ceiling is the end of the last closed hour.
 *
 * Cost: a URL carrying a raw `Date.now()` is different on every single call,
 * so no cached response is ever reusable - the browser refetches identical
 * bytes on every reload, range switch and device toggle. Snapping both ends
 * to hour boundaries makes the URL change once an hour instead of once a
 * millisecond, which is what lets readArchive's Cache-Control mean anything.
 *
 * Asking from the start of the hour containing `fromMs` fetches up to 59
 * minutes more than asked for; the caller clips it back before use, so what
 * reaches the chart is unchanged.
 */
export function requestWindow(fromMs, toMs, nowMs = Date.now()) {
  const lastClosedHourEnd = hourFloor(nowMs) - 1
  const from = hourFloor(fromMs)
  const to = Math.min(hourFloor(toMs) + HOUR_MS - 1, lastClosedHourEnd)
  return { from, to, empty: to < from }
}

export async function fetchArchiveRows(deviceId, tagKey, fromMs, toMs) {
  const base = import.meta.env.VITE_ARCHIVE_API_URL
  if (!base) return []
  if (!auth?.currentUser) throw new Error('archive read attempted with no signed-in user')
  if (!(toMs > fromMs)) return []

  // Nothing to ask for when the whole requested window sits inside the
  // current, still-open hour - the archive cannot hold any of it yet.
  const window = requestWindow(fromMs, toMs)
  if (window.empty) return []

  // Same reasoning as restdb.js: not force-refreshed, because the SDK
  // already renews this well before expiry, so this is normally a cached
  // read rather than a round trip.
  const token = await auth.currentUser.getIdToken()

  const url = new URL(base)
  url.searchParams.set('device', deviceId)
  url.searchParams.set('tag', tagKey)
  url.searchParams.set('from', String(window.from))
  url.searchParams.set('to', String(window.to))

  // X-Id-Token, not Authorization: Bearer - that one is reserved by Cloud
  // Run, which parses it, tries to validate the Firebase ID token as a
  // Google IAM identity token for the service, and rejects the request
  // before the function runs. See the matching note in
  // functions/readArchive.js. Still a header rather than a query
  // parameter, so the token stays out of browser history and access logs.
  const res = await fetch(url.toString(), {
    headers: { 'X-Id-Token': token },
  })

  if (!res.ok) {
    throw new Error(`archive read failed: ${res.status} ${res.statusText}`)
  }

  const body = await res.json()
  const rows = Array.isArray(body?.rows) ? body.rows : []

  // Clip back to the window the caller actually asked for. The request was
  // widened to an hour boundary purely to keep the URL cacheable (see
  // requestWindow), and that widening must not leak into the chart - a 6h
  // range showing 6h59m of history because of a caching detail would be a
  // confusing thing to debug later.
  return rows.filter((r) => {
    const t = Number(r?.t)
    return Number.isFinite(t) && t >= fromMs && t <= toMs
  })
}
