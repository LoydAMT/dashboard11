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
 * One page of one device's alerts, newest first.
 *
 * `cursor` is the opaque value the previous page returned, not a timestamp.
 * Alerts share timestamps constantly - one device can raise a Current and a
 * Voltage alert in the same minute - and paging from "older than this time"
 * dropped whatever shared the boundary minute. See functions/alertQuery.js.
 */
export function fetchAlerts(deviceId, opts = {}) {
  return fetchAlertPage({ device: deviceId }, opts)
}

/**
 * One page of alerts for a whole COMPANY, newest first, across every tenant.
 *
 * Served by one indexed collection-group query on the `companies` field the
 * sweep stamps onto each alert, so a mall of ninety costs the same as a mall
 * of three. Asking each tenant separately would be ninety requests from the
 * browser.
 *
 * FILTERS ARE APPLIED ON THE SERVER. Filtering the page already held here
 * would show one tenant's alerts from among the latest 200 mall-wide and
 * look complete; the server instead reads on until it has a page of
 * matches, and reports `partial` plus how far back it searched when it
 * stops short.
 *
 * Alerts recorded before the sweep began stamping `companies` are not in
 * the mall-wide query. Filter to a SINGLE tenant and the server reads that
 * tenant's own log instead, which does include them.
 */
export function fetchCompanyAlerts(companyId, opts = {}) {
  return fetchAlertPage({ company: companyId }, opts)
}

/**
 * @param scope  { device } or { company }
 * @param opts   { limit, cursor, devices[], kinds[], tags[], since, until }
 */
async function fetchAlertPage(scope, opts = {}) {
  const empty = { alerts: [], hasMore: false, cursor: null, partial: false, searchedTo: null }
  const base = import.meta.env.VITE_ALERTS_API_URL
  if (!base) return empty
  const key = Object.keys(scope)[0]
  if (!scope[key]) return empty
  if (!auth?.currentUser) throw new Error('alert read attempted with no signed-in user')

  const token = await auth.currentUser.getIdToken()
  const url = new URL(base)
  url.searchParams.set(key, scope[key])
  url.searchParams.set('limit', String(opts.limit || 200))
  if (opts.cursor) url.searchParams.set('cursor', opts.cursor)
  for (const name of ['devices', 'kinds', 'tags']) {
    const list = opts[name]
    if (Array.isArray(list) && list.length > 0) url.searchParams.set(name, list.join(','))
  }
  if (opts.since) url.searchParams.set('since', String(opts.since))
  if (opts.until) url.searchParams.set('until', String(opts.until))

  // X-Id-Token, not Authorization: Bearer - Cloud Run intercepts the latter
  // and rejects a Firebase ID token before the function runs. Same reason
  // as lib/archiveApi.js.
  const res = await fetch(url.toString(), { headers: { 'X-Id-Token': token } })
  if (!res.ok) throw new Error(`alert read failed: ${res.status} ${res.statusText}`)

  const body = await res.json()
  return {
    alerts: Array.isArray(body?.alerts) ? body.alerts : [],
    hasMore: Boolean(body?.hasMore),
    cursor: typeof body?.cursor === 'string' ? body.cursor : null,
    partial: Boolean(body?.partial),
    searchedTo: typeof body?.searchedTo === 'number' ? body.searchedTo : null,
  }
}
