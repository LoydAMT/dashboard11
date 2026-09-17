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

export async function fetchArchiveRows(deviceId, tagKey, fromMs, toMs) {
  const base = import.meta.env.VITE_ARCHIVE_API_URL
  if (!base) return []
  if (!auth?.currentUser) throw new Error('archive read attempted with no signed-in user')
  if (!(toMs > fromMs)) return []

  // Same reasoning as restdb.js: not force-refreshed, because the SDK
  // already renews this well before expiry, so this is normally a cached
  // read rather than a round trip.
  const token = await auth.currentUser.getIdToken()

  const url = new URL(base)
  url.searchParams.set('device', deviceId)
  url.searchParams.set('tag', tagKey)
  url.searchParams.set('from', String(Math.floor(fromMs)))
  url.searchParams.set('to', String(Math.floor(toMs)))

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
  return Array.isArray(body?.rows) ? body.rows : []
}
