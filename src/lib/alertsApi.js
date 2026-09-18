// Reads the SERVER-SIDE alert log.
//
// Not to be confused with lib/alerts.js, which is the in-browser notebook
// feeding the toasts and the bell. That one only ever knew about events
// that happened while a tab was open, kept them in localStorage, and capped
// them at 300. This one is the record: written by the alertSweep Cloud
// Function whether or not anybody is watching, stored in Firestore, shared
// across every browser and account, and never trimmed.
//
// Like the archive, it goes through a Cloud Function rather than reading
// Firestore directly, because Firestore rules cannot consult the RTDB
// viewers/operators list that decides who may see a device. The check
// happens server-side against the one real list.
import { auth } from '../firebase'

export const alertsConfigured = () => Boolean(import.meta.env.VITE_ALERTS_API_URL)

/**
 * One page of alerts, newest first.
 *
 * `before` is a cursor (an alert's `ts`), not an offset - paging back
 * through a long history must not get slower the further you go.
 */
export async function fetchAlerts(deviceId, { limit = 200, before = null } = {}) {
  const base = import.meta.env.VITE_ALERTS_API_URL
  if (!base) return { alerts: [], hasMore: false }
  if (!deviceId) return { alerts: [], hasMore: false }
  if (!auth?.currentUser) throw new Error('alert read attempted with no signed-in user')

  const token = await auth.currentUser.getIdToken()

  const url = new URL(base)
  url.searchParams.set('device', deviceId)
  url.searchParams.set('limit', String(limit))
  if (before != null) url.searchParams.set('before', String(before))

  // X-Id-Token, not Authorization: Bearer - Cloud Run intercepts the latter
  // and rejects a Firebase ID token before the function runs. Same reason
  // as lib/archiveApi.js.
  const res = await fetch(url.toString(), { headers: { 'X-Id-Token': token } })
  if (!res.ok) throw new Error(`alert read failed: ${res.status} ${res.statusText}`)

  const body = await res.json()
  return {
    alerts: Array.isArray(body?.alerts) ? body.alerts : [],
    hasMore: Boolean(body?.hasMore),
  }
}
