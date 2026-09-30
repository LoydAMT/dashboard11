import { useMemo, useState } from 'react'
import { ref, update } from 'firebase/database'
import { db } from '../firebase'
import { useRtdbValue } from '../hooks/useRtdbValue'
import { PREMIUM } from '../lib/plans'

const STANDARD = 'standard'

/**
 * Which package each company is on, and which companies are one tenant's own
 * login. Writes companies/{id}/plan and companies/{id}/tenant - the only two
 * fields of a company the rules let a client touch. projectCompanyAccess
 * picks the change up from there and re-derives every meter's plan, so what
 * a customer can open changes within seconds of Save.
 *
 * Saved with a button, not on click: a plan decides what a paying customer
 * can open, and one stray tap must not downgrade them.
 */
export function CompanyPlans() {
  const companies = useRtdbValue('companies', true)

  const list = useMemo(
    () => Object.entries(companies.data || {})
      .filter(([, c]) => c && typeof c === 'object')
      .map(([id, c]) => ({
        id,
        name: typeof c.name === 'string' && c.name ? c.name : id,
        // Every key, whatever its value - the same reading of devices/
        // projectCompanyAccess uses, so this page and the server agree.
        devices: Object.keys(c.devices || {}),
        plan: c.plan === PREMIUM ? PREMIUM : STANDARD,
        tenant: c.tenant === true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [companies.data],
  )

  // device -> names of the Premium companies holding it. The plan follows
  // the meter, so this is what explains a Standard company whose meters are
  // Premium anyway, and whether a tenant login is open.
  const premiumVia = useMemo(() => {
    const out = {}
    for (const c of list) {
      if (c.plan !== PREMIUM) continue
      for (const d of c.devices) (out[d] = out[d] || []).push(c.name)
    }
    return out
  }, [list])

  return (
    <section className="admin-card">
      <h3 className="plans-title">Plans</h3>
      <p className="admin-hint">
        Which package each company is on. A meter is Premium when any company
        holding it is, so a mall on Premium covers all of its tenants.
      </p>
      <p className="admin-hint">
        Tick <strong>Tenant login</strong> for a company that is one tenant&apos;s
        own sign-in. It only gets in while its meter is on Premium.
      </p>

      {companies.error && (
        <p className="naming-row-error" role="alert">
          Could not read companies: {companies.error.message || String(companies.error)}
        </p>
      )}
      {companies.loading && <p className="admin-hint">Loading companies…</p>}
      {!companies.loading && !companies.error && list.length === 0 && (
        <p className="admin-hint">No companies yet.</p>
      )}

      {list.length > 0 && (
        <div className="plan-list">
          {list.map((c) => <PlanRow key={c.id} company={c} premiumVia={premiumVia} />)}
        </div>
      )}
    </section>
  )
}

function PlanRow({ company, premiumVia }) {
  // null = untouched, follow the database. Same pattern as the name field.
  const [planDraft, setPlanDraft] = useState(null)
  const [tenantDraft, setTenantDraft] = useState(null)
  const [state, setState] = useState(null)   // 'saved' | 'error'
  const [error, setError] = useState(null)

  const plan = planDraft ?? company.plan
  const tenant = tenantDraft ?? company.tenant
  const dirty = plan !== company.plan || tenant !== company.tenant

  const edit = (fn) => { fn(); setState(null); setError(null) }

  const save = async () => {
    // Only what changed. tenant is removed rather than stored as false, so
    // an untouched company stays exactly as the console left it.
    const changes = {}
    if (plan !== company.plan) changes.plan = plan
    if (tenant !== company.tenant) changes.tenant = tenant ? true : null
    setError(null)
    try {
      await update(ref(db, `companies/${company.id}`), changes)
      setPlanDraft(null); setTenantDraft(null)
      setState('saved')
      setTimeout(() => setState(null), 1500)
    } catch (err) {
      setState('error')
      setError(err?.message || String(err))
    }
  }

  const n = company.devices.length
  const status = describe(company, premiumVia)

  return (
    <div className="naming-row plan-row">
      <div className="plan-row-name">
        <span className="plan-row-label">{company.name}</span>
        <span className="plan-row-meta">
          {company.id} · {n} meter{n === 1 ? '' : 's'}
        </span>
      </div>

      <div className="ranges" role="group" aria-label={`Plan for ${company.name}`}>
        {[[STANDARD, 'Standard'], [PREMIUM, 'Premium']].map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`range-btn ${plan === value ? 'range-active' : ''}`}
            aria-pressed={plan === value}
            onClick={() => edit(() => setPlanDraft(value))}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="plan-tenant">
        <input
          type="checkbox"
          checked={tenant}
          onChange={(e) => { const on = e.target.checked; edit(() => setTenantDraft(on)) }}
        />
        Tenant login
      </label>

      <button
        type="button"
        className="signout-btn naming-save"
        onClick={save}
        disabled={!dirty && state !== 'error'}
      >
        {state === 'saved' ? 'Saved' : state === 'error' ? 'Error' : 'Save'}
      </button>

      {status && <p className="admin-hint plan-row-status">{status}</p>}
      {error && <span className="naming-row-error" role="alert">{error}</span>}
    </div>
  )
}

/**
 * What the SAVED settings mean for this company, in a sentence - or nothing
 * when the switch already says it all. Deliberately not the draft: this is
 * what customers are getting right now.
 */
function describe(company, premiumVia) {
  const n = company.devices.length
  const covered = company.devices.filter((d) => premiumVia[d]?.length).length
  const meters = n === 1 ? 'its meter is' : 'its meters are'

  if (company.tenant) {
    if (n === 0) return 'Tenant login, but it holds no meters yet.'
    if (covered === n) return `Tenant login open: ${meters} on Premium.`
    if (covered === 0) {
      return `Tenant login blocked: ${meters} on Standard. It opens once the building is on Premium.`
    }
    return `Tenant login open for ${covered} of ${n} meters; the rest are on Standard.`
  }

  if (company.plan !== PREMIUM && covered > 0) {
    const via = [...new Set(company.devices.flatMap((d) => premiumVia[d] || []))]
    return `${covered} of ${n} meters are Premium anyway, through ${via.join(', ')}.`
  }

  return null
}
