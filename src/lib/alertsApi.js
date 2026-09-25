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
export async function fetchCompanyAlerts(companyId, { limit = 200, before = null } = {}) {
  return fetchAlertPage({ company: companyId }, { limit, before })
}

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

/**
 * One page of alerts for a whole COMPANY, newest first, across every tenant
 * in it.
 *
 * Served by one indexed collection-group query on the `companies` field the
 * sweep stamps onto each alert, so a mall of ninety costs the same single
 * read as a mall of three. Asking each tenant separately would be ninety
 * requests from the browser and would get slower the more tenants a
 * landlord has - the opposite of what a landlord's page needs.
 *
 * Alerts written before that field existed carry no `companies` and will
 * not appear here. They are still on their own device's page, which is the
 * complete record; this view fills from the moment the sweep started
 * stamping.
 */
async function fetchAlertPage(scope, { limit = 200, before = null } = {}) {
  const base = import.meta.env.VITE_ALERTS_API_URL
  if (!base) return { alerts: [], hasMore: false }
  const key = Object.keys(scope)[0]
  if (!scope[key]) return { alerts: [], hasMore: false }
  if (!auth?.currentUser) throw new Error('alert read attempted with no signed-in user')

  const token = await auth.currentUser.getIdToken()
  const url = new URL(base)
  url.searchParams.set(key, scope[key])
  url.searchParams.set('limit', String(limit))
  if (before != null) url.searchParams.set('before', String(before))

  const res = await fetch(url.toString(), { headers: { 'X-Id-Token': token } })
  if (!res.ok) throw new Error(`alert read failed: ${res.status} ${res.statusText}`)
  const body = await res.json()
  return {
    alerts: Array.isArray(body?.alerts) ? body.alerts : [],
    hasMore: Boolean(body?.hasMore),
  }
}
