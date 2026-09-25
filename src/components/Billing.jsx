import { useEffect, useMemo, useState } from 'react'
import { ref, update, set } from 'firebase/database'
import { db } from '../firebase'
import { useRtdbValue } from '../hooks/useRtdbValue'
import { useMallOverview } from '../hooks/useMallOverview'
import { billing, parseEmails, money, dayText } from '../lib/billingApi'
import { BackButton } from './BackButton'
import { BillRun, RunBadge } from './BillRun'

/**
 * Electricity billing for one company: settings, tenant contacts, and bill
 * runs.
 *
 * Nothing here touches the boxes. A bill is worked out from the meter
 * readings each box already takes at 22:00 and keeps for ever; the rate,
 * the emails and the bills themselves are company data the box never sees.
 *
 * NOTHING IS EMAILED FROM THIS PAGE WITHOUT A REVIEW STEP. Preparing a run
 * only produces drafts. Sending is a separate, confirmed action, because an
 * email in a tenant's inbox cannot be taken back.
 */
export function Billing({ companyId, companyName, onClose, nowMs }) {
  const settings = useRtdbValue(`companyBilling/${companyId}`, true)
  const { tenants } = useMallOverview(companyId)
  const [meta, setMeta] = useState({ loading: true, canEdit: false, runs: [], error: null })
  const [openRun, setOpenRun] = useState(null)
  const [tab, setTab] = useState(null)
  const [reloads, setReloads] = useState(0)

  // Runs and the caller's edit right come from the server, which is where
  // membership is actually checked. State is set only in the callbacks.
  useEffect(() => {
    let cancelled = false
    billing.runs(companyId).then(
      (r) => { if (!cancelled) setMeta({ loading: false, canEdit: r.canEdit, runs: r.runs || [], error: null }) },
      (e) => { if (!cancelled) setMeta((m) => ({ ...m, loading: false, error: e.message })) },
    )
    return () => { cancelled = true }
  }, [companyId, reloads])

  const cfg = settings.data || {}
  const configured = Number(cfg.ratePerKwh) > 0
  // Land on Settings the first time, when there is nothing to bill with yet.
  const current = tab || (settings.loading ? 'bills' : configured ? 'bills' : 'settings')

  if (openRun) {
    return (
      <BillRun
        companyId={companyId}
        companyName={companyName}
        runId={openRun}
        canEdit={meta.canEdit}
        onClose={() => { setOpenRun(null); setReloads((n) => n + 1) }}
      />
    )
  }

  const missingEmail = tenants.filter((t) => parseEmails(cfg.tenants?.[t.id]?.emails).valid.length === 0)

  return (
    <div className="subpage billing">
      <BackButton onClick={onClose}>{companyName || 'All tenants'}</BackButton>
      <header className="subpage-head">
        <h2>Billing</h2>
        <p className="subpage-sub">
          Bills are worked out from each tenant&apos;s own meter, which takes a reading at 22:00
          every night. Nothing is emailed until you review the drafts and press Send.
        </p>
      </header>

      {!meta.canEdit && !meta.loading && (
        <div className="notice notice-info">
          <p>You can view bills for this company. Preparing and sending them needs an operator.</p>
        </div>
      )}

      <nav className="tabs" role="tablist">
        {[['bills', 'Bills'], ['tenants', `Tenants${missingEmail.length ? ` · ${missingEmail.length} without email` : ''}`], ['settings', 'Settings']]
          .map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={current === id}
                    className={current === id ? 'is-on' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
      </nav>

      {current === 'settings' && (
        settings.loading
          ? <p className="alog-empty">Loading…</p>
          : <SettingsForm key="form" companyId={companyId} initial={cfg} canEdit={meta.canEdit} />
      )}

      {current === 'tenants' && (
        <div className="bill-card">
          <p className="bill-hint">
            Who receives each tenant&apos;s bill. Separate several addresses with commas.
            Changes apply to the next bills you prepare or refresh.
          </p>
          <div className="contacts">
            {tenants.length === 0 && <p className="alog-empty">No tenants reporting into this company yet.</p>}
            {[...tenants].sort((a, b) => a.name.localeCompare(b.name)).map((t) => (
              <ContactRow
                key={`${t.id}:${settings.loading ? 0 : 1}`}
                companyId={companyId}
                tenant={t}
                initial={cfg.tenants?.[t.id] || {}}
                canEdit={meta.canEdit}
              />
            ))}
          </div>
        </div>
      )}

      {current === 'bills' && (
        <>
          {!configured && !settings.loading && (
            <div className="notice notice-warn">
              <p>Set a rate per kWh under <button type="button" className="alog-link" onClick={() => setTab('settings')}>Settings</button> before preparing bills.</p>
            </div>
          )}
          {meta.canEdit && configured && (
            <PrepareForm companyId={companyId} nowMs={nowMs} onPrepared={(id) => setOpenRun(id)} />
          )}
          <RunList meta={meta} onOpen={setOpenRun} />
        </>
      )}
    </div>
  )
}

/**
 * Company-wide billing settings. Mounted once the stored values have
 * arrived, so its fields start from them without an effect copying data
 * into state.
 */
function SettingsForm({ companyId, initial, canEdit }) {
  const [f, setF] = useState({
    senderName: initial.senderName || '',
    replyTo: initial.replyTo || '',
    ratePerKwh: initial.ratePerKwh ?? '',
    vatPct: initial.vatPct ?? 0,
    fixedCharge: initial.fixedCharge ?? 0,
    footer: initial.footer || '',
  })
  const [state, setState] = useState({ saving: false, saved: false, error: null })
  const put = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setState((s) => ({ ...s, saved: false })) }

  const rate = Number(f.ratePerKwh)
  const reply = parseEmails(f.replyTo)
  const problems = []
  if (!(rate > 0)) problems.push('Enter a rate above zero')
  if (f.replyTo && reply.valid.length === 0) problems.push('The company email does not look like an address')
  if (Number(f.vatPct) < 0 || Number(f.vatPct) > 100) problems.push('VAT must be between 0 and 100')

  const save = async () => {
    setState({ saving: true, saved: false, error: null })
    try {
      // update(), not set(): the tenant contacts live under the same node
      // and must survive a settings save.
      await update(ref(db, `companyBilling/${companyId}`), {
        senderName: f.senderName.trim(),
        replyTo: reply.valid[0] || '',
        ratePerKwh: rate,
        vatPct: Number(f.vatPct) || 0,
        fixedCharge: Number(f.fixedCharge) || 0,
        footer: f.footer.trim(),
      })
      setState({ saving: false, saved: true, error: null })
    } catch (e) {
      setState({ saving: false, saved: false, error: e.message })
    }
  }

  // A worked example, so a rate typo is caught by eye before it is billed.
  const example = 100
  const energy = Math.round(example * (rate || 0) * 100)
  const fixed = Math.round((Number(f.fixedCharge) || 0) * 100)
  const vat = Math.round((energy + fixed) * (Number(f.vatPct) || 0) / 100)

  return (
    <div className="bill-card">
      <div className="form-grid">
        <Field label="Name on bills" hint="Shown to tenants as who the bill is from">
          <input value={f.senderName} onChange={put('senderName')} disabled={!canEdit} placeholder="Demo Mall" maxLength={80} />
        </Field>
        <Field label="Company email" hint="Tenants' replies go here, and it gets a copy of every bill">
          <input type="email" value={f.replyTo} onChange={put('replyTo')} disabled={!canEdit} placeholder="billing@yourmall.ph" />
        </Field>
        <Field label="Rate per kWh" hint="Before VAT">
          <div className="input-affix"><span>₱</span>
            <input type="number" min="0" step="0.0001" value={f.ratePerKwh} onChange={put('ratePerKwh')} disabled={!canEdit} placeholder="12.50" />
          </div>
        </Field>
        <Field label="VAT" hint="Added on top. Use 0 if your rate already includes it">
          <div className="input-affix"><input type="number" min="0" max="100" step="0.01" value={f.vatPct} onChange={put('vatPct')} disabled={!canEdit} /><span>%</span></div>
        </Field>
        <Field label="Fixed monthly charge" hint="Optional, e.g. a meter fee. Charged once per bill">
          <div className="input-affix"><span>₱</span>
            <input type="number" min="0" step="0.01" value={f.fixedCharge} onChange={put('fixedCharge')} disabled={!canEdit} />
          </div>
        </Field>
        <Field label="Note on every bill" hint="Payment instructions, due date, account numbers" wide>
          <textarea rows={3} value={f.footer} onChange={put('footer')} disabled={!canEdit} maxLength={1000}
                    placeholder="Please pay within 15 days to …" />
        </Field>
      </div>

      {rate > 0 && (
        <p className="bill-example">
          Example: {example} kWh → {money(energy / 100)} energy
          {fixed > 0 && <> + {money(fixed / 100)} fixed</>}
          {vat > 0 && <> + {money(vat / 100)} VAT</>}
          {' '}= <b>{money((energy + fixed + vat) / 100)}</b>
        </p>
      )}

      {canEdit && (
        <div className="form-foot">
          {problems.length > 0 && <span className="form-problem">{problems[0]}</span>}
          {state.error && <span className="form-problem">Could not save: {state.error}</span>}
          {state.saved && <span className="form-ok">Saved</span>}
          <button type="button" className="btn btn-primary" onClick={save} disabled={state.saving || problems.length > 0}>
            {state.saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, wide, children }) {
  return (
    <label className={`field ${wide ? 'field-wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

/** One tenant's billing name and addresses, saved independently. */
function ContactRow({ companyId, tenant, initial, canEdit }) {
  const [name, setName] = useState(initial.billingName || '')
  const [emails, setEmails] = useState(initial.emails || '')
  const [state, setState] = useState({ saving: false, saved: false, error: null })
  const parsed = parseEmails(emails)
  const dirty = name !== (initial.billingName || '') || emails !== (initial.emails || '')

  const save = async () => {
    setState({ saving: true, saved: false, error: null })
    try {
      await set(ref(db, `companyBilling/${companyId}/tenants/${tenant.id}`), {
        billingName: name.trim(),
        // Stored normalised, so what is saved is what will be sent to.
        emails: parsed.valid.join(', '),
      })
      setEmails(parsed.valid.join(', '))
      setState({ saving: false, saved: true, error: null })
    } catch (e) {
      setState({ saving: false, saved: false, error: e.message })
    }
  }

  return (
    <div className={`contact ${parsed.valid.length === 0 ? 'is-missing' : ''}`}>
      <div className="contact-who">
        <b>{tenant.name}</b>
        <span className="contact-id">{tenant.id}</span>
      </div>
      <input className="contact-name" value={name} onChange={(e) => { setName(e.target.value); setState({}) }}
             disabled={!canEdit} placeholder={`Name on bill (default: ${tenant.name})`} maxLength={120} />
      <input className="contact-emails" value={emails} onChange={(e) => { setEmails(e.target.value); setState({}) }}
             disabled={!canEdit} placeholder="accounts@tenant.ph, owner@tenant.ph" />
      <div className="contact-status">
        {parsed.invalid.length > 0
          ? <span className="form-problem">Not an address: {parsed.invalid.join(', ')}</span>
          : parsed.valid.length === 0
            ? <span className="contact-none">No email yet</span>
            : state.saved ? <span className="form-ok">Saved</span> : null}
        {state.error && <span className="form-problem">{state.error}</span>}
      </div>
      {canEdit && (
        <button type="button" className="btn btn-quiet" onClick={save}
                disabled={!dirty || state.saving || parsed.invalid.length > 0}>
          {state.saving ? 'Saving…' : 'Save'}
        </button>
      )}
    </div>
  )
}

/**
 * Choose the dates to bill. Quick picks for the common cases; any range for
 * the rest. The closing reading is taken at 22:00, so the latest date that
 * can be billed is today after 22:00, otherwise yesterday.
 */
function PrepareForm({ companyId, nowMs, onPrepared }) {
  const ph = phParts(nowMs)
  const latest = ph.hour >= 22 ? ph.today : ph.yesterday
  const presets = useMemo(() => {
    const out = [{ id: 'last', label: 'Last month', from: ph.lastMonthFrom, to: ph.lastMonthTo }]
    if (ph.monthFrom <= latest) out.push({ id: 'mtd', label: 'This month so far', from: ph.monthFrom, to: latest })
    return out
  }, [ph.lastMonthFrom, ph.lastMonthTo, ph.monthFrom, latest])

  const [from, setFrom] = useState(presets[0].from)
  const [to, setTo] = useState(presets[0].to)
  const [state, setState] = useState({ busy: false, error: null })

  const tooLate = to > latest
  const backwards = from > to

  const prepare = async () => {
    setState({ busy: true, error: null })
    try {
      const r = await billing.prepare(companyId, from, to)
      onPrepared(r.run.id)
    } catch (e) {
      setState({ busy: false, error: e.message })
    }
  }

  return (
    <div className="bill-card prepare">
      <div className="prepare-head">
        <h3>Prepare bills</h3>
        <div className="seg">
          {presets.map((p) => (
            <button key={p.id} type="button" className={from === p.from && to === p.to ? 'is-on' : ''}
                    onClick={() => { setFrom(p.from); setTo(p.to) }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="prepare-row">
        <label className="field"><span className="field-label">From</span>
          <input type="date" value={from} max={latest} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field"><span className="field-label">To</span>
          <input type="date" value={to} max={latest} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="btn btn-primary" onClick={prepare}
                disabled={state.busy || !from || !to || tooLate || backwards}>
          {state.busy ? 'Reading meters…' : 'Prepare drafts'}
        </button>
      </div>
      <p className="bill-hint">
        {from && to && !backwards
          ? <>Meter read to meter read: 22:00 on the day before {dayText(from)} to 22:00 on {dayText(to)}. Nothing is sent yet.</>
          : 'Pick a start and end date.'}
      </p>
      {tooLate && <p className="form-problem">The reading for {dayText(to)} is taken at 22:00 and has not happened yet.</p>}
      {backwards && <p className="form-problem">The end date is before the start date.</p>}
      {state.error && <p className="form-problem">{state.error}</p>}
    </div>
  )
}

function RunList({ meta, onOpen }) {
  if (meta.loading) return <p className="alog-empty">Loading bills…</p>
  if (meta.error) return <div className="notice notice-warn"><p>Could not load bills: {meta.error}</p></div>
  if (meta.runs.length === 0) return <p className="alog-empty">No bills prepared yet.</p>

  return (
    <div className="bill-card">
      <h3 className="bill-card-title">Bill runs</h3>
      <ul className="runs">
        {meta.runs.map((r) => (
          <li key={r.id}>
            <button type="button" className="run" onClick={() => onOpen(r.id)}>
              <span className="run-period">{dayText(r.periodFrom)} – {dayText(r.periodTo)}</span>
              <RunBadge status={r.summary?.status} />
              <span className="run-count">
                {r.summary?.sent || 0} of {r.summary?.included || 0} sent
              </span>
              <span className="run-total">{money(r.summary?.total)}</span>
              <span className="run-open" aria-hidden="true">›</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------

/** Philippine calendar dates around `nowMs`, as yyyy-mm-dd strings. */
function phParts(nowMs) {
  const d = new Date(nowMs + 8 * 3600000)
  const y = d.getUTCFullYear(); const m = d.getUTCMonth(); const day = d.getUTCDate()
  const iso = (Y, M, D) => new Date(Date.UTC(Y, M, D)).toISOString().slice(0, 10)
  return {
    hour: d.getUTCHours(),
    today: iso(y, m, day),
    yesterday: iso(y, m, day - 1),
    monthFrom: iso(y, m, 1),
    lastMonthFrom: iso(y, m - 1, 1),
    lastMonthTo: iso(y, m, 0),
  }
}
