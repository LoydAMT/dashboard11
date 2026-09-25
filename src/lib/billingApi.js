// Client for the billing Cloud Functions.
//
// Bills live in Firestore, which the browser cannot read directly - its
// rules cannot consult the RTDB membership list that decides who may see a
// company. So every bill operation goes through billingApi, which checks
// membership server-side. billingSend is separate and is the only function
// holding the email key; it may not be deployed yet, which the page detects
// with sendStatus() rather than assuming.
import { auth } from '../firebase'
import { functionUrl } from './functionUrl'

async function call(fn, { method = 'GET', params = {}, body = null } = {}) {
  const base = functionUrl(fn)
  if (!base) throw new Error('Firebase project is not configured for this build')
  if (!auth?.currentUser) throw new Error('Not signed in')

  const token = await auth.currentUser.getIdToken()
  const url = new URL(base)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      // X-Id-Token, not Authorization: Bearer - Cloud Run intercepts the
      // latter and rejects a Firebase ID token before the function runs.
      'X-Id-Token': token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  // The server's own sentence where it gave one - "Set a rate per kWh
  // first" is something a person can act on; "HTTP 400" is not.
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export const billing = {
  runs: (company) => call('billingApi', { params: { action: 'runs', company } }),
  run: (company, run) => call('billingApi', { params: { action: 'run', company, run } }),
  preview: (company, run, device) => call('billingApi', { params: { action: 'preview', company, run, device } }),
  prepare: (company, from, to) =>
    call('billingApi', { method: 'POST', body: { action: 'prepare', company, from, to } }),
  update: (company, run, device, patch) =>
    call('billingApi', { method: 'POST', body: { action: 'update', company, run, device, ...patch } }),
  discard: (company, run) =>
    call('billingApi', { method: 'POST', body: { action: 'discard', company, run } }),
  sendStatus: () => call('billingSend', { params: { action: 'status' } }),
  send: (company, run, devices = null) =>
    call('billingSend', { method: 'POST', body: { action: 'send', company, run, ...(devices ? { devices } : {}) } }),
}

/**
 * "a@x.ph, B@Y.ph; junk" -> { valid, invalid }. Mirrors the server's own
 * check (functions/billing.js) so the contacts form flags a typo before a
 * bill is prepared with it, rather than after it fails to send.
 */
export function parseEmails(raw) {
  const valid = []
  const invalid = []
  for (const part of String(raw || '').split(/[,;\s]+/)) {
    const e = part.trim().toLowerCase()
    if (!e) continue
    if (/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(e)) {
      if (!valid.includes(e)) valid.push(e)
    } else if (!invalid.includes(part.trim())) {
      invalid.push(part.trim())
    }
  }
  return { valid, invalid }
}

const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' })
export const money = (v) => peso.format(v || 0)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** '2026-09-01' -> '1 Sep 2026'. By hand, to match the emailed bill exactly. */
export function dayText(s) {
  const [y, m, d] = String(s).split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}
