import { useEffect, useState } from 'react'
import { billing, money, dayText } from '../lib/billingApi'
import { BackButton } from './BackButton'

const FLAG_TEXT = {
  'no-readings': 'No meter readings for this period',
  'meter-reset': 'The meter reset during this period - check the figure',
  'start-reading-off': 'Opening reading was not taken at 22:00',
  'end-reading-off': 'Closing reading was not taken at 22:00',
  'no-email': 'No email address - add one under Tenants, then Refresh',
}

/**
 * One bill run: every tenant's draft, reviewed before anything is sent.
 *
 * The screen is built around the review, because that is the only point at
 * which a mistake is free to fix. Flagged bills say why, a figure can be
 * adjusted - with a reason the tenant will see - or a tenant left out, and
 * each email can be previewed exactly as it will arrive. Sending is a
 * second, confirmed step.
 */
export function BillRun({ companyId, companyName, runId, canEdit, onClose }) {
  const [data, setData] = useState({ loading: true, run: null, bills: [], error: null })
  const [sendable, setSendable] = useState({ checked: false, ok: false, from: null })
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(null)
  const [notice, setNotice] = useState(null)
  const [preview, setPreview] = useState(null)
  const [editing, setEditing] = useState(null)

  useEffect(() => {
    let cancelled = false
    billing.run(companyId, runId).then(
      (r) => { if (!cancelled) setData({ loading: false, run: r.run, bills: r.bills, error: null }) },
      (e) => { if (!cancelled) setData((d) => ({ ...d, loading: false, error: e.message })) },
    )
    // Whether email sending exists at all. It is a separately deployed
    // function; until its key is set it is simply absent, and the page
    // says so instead of offering a button that cannot work.
    billing.sendStatus().then(
      (s) => { if (!cancelled) setSendable({ checked: true, ok: Boolean(s.ok), from: s.from || null }) },
      () => { if (!cancelled) setSendable({ checked: true, ok: false, from: null }) },
    )
    return () => { cancelled = true }
  }, [companyId, runId])

  const act = async (label, fn) => {
    setBusy(label)
    setNotice(null)
    try { await fn() } catch (e) { setNotice({ bad: true, text: e.message }) }
    setBusy(null)
  }

  const refresh = () => act('refresh', async () => {
    const r = await billing.prepare(companyId, data.run.periodFrom, data.run.periodTo)
    setData({ loading: false, run: r.run, bills: r.bills, error: null })
    setNotice({ text: 'Readings, rates and contacts re-read. Your inclusions and adjustments were kept.' })
  })

  const patch = (deviceId, change) => act(`bill:${deviceId}`, async () => {
    const r = await billing.update(companyId, runId, deviceId, change)
    setData((d) => ({
      ...d,
      run: { ...d.run, summary: r.summary },
      bills: d.bills.map((b) => (b.deviceId === deviceId ? r.bill : b)),
    }))
    setEditing(null)
  })

  const send = () => act('send', async () => {
    const r = await billing.send(companyId, runId)
    const fresh = await billing.run(companyId, runId)
    setData({ loading: false, run: fresh.run, bills: fresh.bills, error: null })
    setConfirming(false)
    const sent = r.results.filter((x) => x.sent).length
    const failed = r.results.filter((x) => x.error).length
    setNotice(failed
      ? { bad: true, text: `${sent} sent, ${failed} failed - see the rows marked Failed.` }
      : { text: `${sent} bill${sent === 1 ? '' : 's'} sent.` })
  })

  const discard = () => act('discard', async () => {
    await billing.discard(companyId, runId)
    onClose()
  })

  const openPreview = (deviceId) => act(`preview:${deviceId}`, async () => {
    setPreview(await billing.preview(companyId, runId, deviceId))
  })

  if (data.loading) return <div className="subpage"><p className="alog-empty">Loading…</p></div>
  if (data.error) {
    return (
      <div className="subpage">
        <BackButton onClick={onClose}>Billing</BackButton>
        <div className="notice notice-warn"><p>Could not load this run: {data.error}</p></div>
      </div>
    )
  }

  const { run, bills } = data
  const s = run.summary || {}
  const ready = bills.filter((b) => b.included && b.status !== 'sent' && !blockerOf(b))
  const readyTotal = ready.reduce((t, b) => t + Math.round((b.total || 0) * 100), 0) / 100
  const anySent = bills.some((b) => b.status === 'sent')
  const sorted = [...bills].sort((a, b) => rank(a) - rank(b) || a.tenantName.localeCompare(b.tenantName))

  return (
    <div className="subpage billing">
      <BackButton onClick={onClose}>Billing</BackButton>
      <header className="subpage-head run-head">
        <div>
          <h2>{dayText(run.periodFrom)} – {dayText(run.periodTo)}</h2>
          <p className="subpage-sub">
            {companyName} · {run.days} day{run.days === 1 ? '' : 's'} · {money(run.settings?.ratePerKwh)} per kWh
            {run.settings?.vatPct > 0 && ` + ${run.settings.vatPct}% VAT`}
          </p>
        </div>
        <RunBadge status={s.status} />
      </header>

      <div className="mall-totals">
        <div className="mall-stat"><span className="mall-stat-n">{s.included ?? 0}</span><span className="mall-stat-l">tenants billed</span></div>
        <div className="mall-stat"><span className="mall-stat-n">{money(s.total)}</span><span className="mall-stat-l">total</span></div>
        <div className={`mall-stat ${s.blocked ? 'is-bad' : ''}`}><span className="mall-stat-n">{s.blocked ?? 0}</span><span className="mall-stat-l">need attention</span></div>
        <div className="mall-stat"><span className="mall-stat-n">{s.sent ?? 0}</span><span className="mall-stat-l">sent</span></div>
      </div>

      {notice && <div className={`notice ${notice.bad ? 'notice-warn' : 'notice-info'}`}><p>{notice.text}</p></div>}

      {sendable.checked && !sendable.ok && (
        <div className="notice notice-info">
          <p>
            Email sending is not set up yet. You can prepare, review and preview bills;
            sending turns on once the Resend key is added.
          </p>
        </div>
      )}

      {canEdit && (
        <div className="run-actions">
          <button type="button" className="btn" onClick={refresh} disabled={Boolean(busy)}>
            {busy === 'refresh' ? 'Re-reading…' : '↻ Refresh readings'}
          </button>
          {!anySent && (
            <button type="button" className="btn btn-danger-quiet" onClick={discard} disabled={Boolean(busy)}>
              Discard draft
            </button>
          )}
          <span className="run-actions-gap" />
          <button type="button" className="btn btn-primary" onClick={() => setConfirming(true)}
                  disabled={Boolean(busy) || ready.length === 0 || !sendable.ok}>
            Send {ready.length} bill{ready.length === 1 ? '' : 's'}
          </button>
        </div>
      )}

      {confirming && (
        <div className="confirm">
          <p>
            Email <b>{ready.length}</b> bill{ready.length === 1 ? '' : 's'} totalling <b>{money(readyTotal)}</b> to
            tenants now? {run.settings?.replyTo && <>A copy of each goes to {run.settings.replyTo}. </>}
            This cannot be undone.
          </p>
          <div className="confirm-actions">
            <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy === 'send'}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={send} disabled={busy === 'send'}>
              {busy === 'send' ? 'Sending…' : 'Send now'}
            </button>
          </div>
        </div>
      )}

      <div className="bills">
        {sorted.map((b) => (
          <BillRow
            key={b.deviceId}
            bill={b}
            canEdit={canEdit}
            busy={busy === `bill:${b.deviceId}`}
            editing={editing === b.deviceId}
            onEdit={() => setEditing(b.deviceId)}
            onCancelEdit={() => setEditing(null)}
            onPatch={(change) => patch(b.deviceId, change)}
            onPreview={() => openPreview(b.deviceId)}
            previewing={busy === `preview:${b.deviceId}`}
          />
        ))}
      </div>

      {preview && <PreviewModal mail={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

function BillRow({ bill: b, canEdit, busy, editing, onEdit, onCancelEdit, onPatch, onPreview, previewing }) {
  const sent = b.status === 'sent'
  const blocker = b.included && !sent ? blockerOf(b) : null
  const flags = (b.flags || []).filter((f) => f !== 'no-email' || !sent)

  return (
    <div className={`bill ${!b.included ? 'is-out' : ''} ${sent ? 'is-sent' : ''} ${blocker ? 'is-blocked' : ''}`}>
      <div className={`bill-main${canEdit && !sent ? "" : " no-check"}`}>
        {canEdit && !sent && (
          <input type="checkbox" className="bill-include" checked={Boolean(b.included)} disabled={busy}
                 title={b.included ? 'Leave this tenant out of this run' : 'Include this tenant'}
                 onChange={(e) => onPatch({ included: e.target.checked })} />
        )}
        <div className="bill-who">
          <b>{b.tenantName}</b>
          <span className="bill-to">{b.to?.length ? b.to.join(', ') : 'no email'}</span>
        </div>
        <div className="bill-readings" title="Opening and closing meter readings">
          {b.start && b.end
            ? <>{fmtKwh(b.start.value)} → {fmtKwh(b.end.value)}</>
            : <span className="contact-none">no readings</span>}
        </div>
        <div className="bill-kwh">
          {Number.isFinite(b.kwh) ? <><b>{fmtKwh(b.kwh)}</b> kWh</> : '—'}
          {Number.isFinite(b.adjustKwh) && <span className="bill-adjusted" title={b.adjustNote}>adjusted</span>}
        </div>
        <div className="bill-amount">{Number.isFinite(b.kwh) ? money(b.total) : '—'}</div>
        <div className="bill-status"><StatusPill bill={b} blocker={blocker} /></div>
        <div className="bill-tools">
          <button type="button" className="btn btn-quiet" onClick={onPreview} disabled={previewing || !Number.isFinite(b.kwh)}>
            {previewing ? '…' : 'Preview'}
          </button>
          {canEdit && !sent && !editing && (
            <button type="button" className="btn btn-quiet" onClick={onEdit}>Adjust</button>
          )}
        </div>
      </div>

      {flags.length > 0 && (
        <ul className="bill-flags">
          {flags.map((f) => <li key={f}>{FLAG_TEXT[f] || f}</li>)}
        </ul>
      )}
      {b.lastError && <p className="form-problem">Last attempt failed: {b.lastError}</p>}
      {sent && b.sentAt && <p className="bill-sentline">Sent {fmtWhen(b.sentAt)} to {(b.sentTo || b.to || []).join(', ')}</p>}

      {editing && <AdjustForm bill={b} busy={busy} onSave={onPatch} onCancel={onCancelEdit} />}
    </div>
  )
}

/**
 * Replace the measured figure - for a meter reset, a replaced meter, an
 * agreed estimate. The measured figure is kept on the bill, and the reason
 * is printed on what the tenant receives: an adjusted charge they cannot
 * see explained is the one they will dispute.
 */
function AdjustForm({ bill, busy, onSave, onCancel }) {
  const [kwh, setKwh] = useState(Number.isFinite(bill.adjustKwh) ? String(bill.adjustKwh) : '')
  const [note, setNote] = useState(bill.adjustNote || '')
  const n = Number(kwh)
  const valid = kwh !== '' && Number.isFinite(n) && n >= 0 && note.trim().length > 0

  return (
    <div className="adjust">
      <p className="bill-hint">
        Measured: {Number.isFinite(bill.measuredKwh) ? `${fmtKwh(bill.measuredKwh)} kWh` : 'no figure'}.
        Enter the kWh to charge, and why - the tenant sees the reason on their bill.
      </p>
      <div className="adjust-row">
        <div className="input-affix"><input type="number" min="0" step="0.01" value={kwh} onChange={(e) => setKwh(e.target.value)} placeholder="kWh" /><span>kWh</span></div>
        <input className="adjust-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
               placeholder="Reason, e.g. meter replaced on 12 Sep" />
        <button type="button" className="btn btn-primary" disabled={!valid || busy}
                onClick={() => onSave({ adjustKwh: n, adjustNote: note.trim() })}>Save</button>
        {Number.isFinite(bill.adjustKwh) && (
          <button type="button" className="btn" disabled={busy} onClick={() => onSave({ adjustKwh: null })}>Use measured</button>
        )}
        <button type="button" className="btn btn-quiet" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export function RunBadge({ status }) {
  const label = { draft: 'Draft', partial: 'Partly sent', sent: 'Sent' }[status] || 'Draft'
  return <span className={`badge badge-${status || 'draft'}`}>{label}</span>
}

function StatusPill({ bill, blocker }) {
  if (bill.status === 'sent') return <span className="pill pill-sent">Sent</span>
  if (bill.status === 'sending') return <span className="pill pill-wait">Sending…</span>
  if (bill.status === 'failed') return <span className="pill pill-bad">Failed</span>
  if (!bill.included) return <span className="pill">Left out</span>
  if (blocker) return <span className="pill pill-bad" title={blocker}>Can&apos;t send</span>
  return <span className="pill pill-ok">Ready</span>
}

/** The email exactly as the tenant will receive it, rendered in isolation. */
function PreviewModal({ mail, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Bill preview">
        <div className="modal-head">
          <div>
            <div className="modal-subject">{mail.subject}</div>
            <div className="modal-meta">
              To {mail.to?.length ? mail.to.join(', ') : '(no address)'}
              {mail.replyTo && <> · Reply-To and copy {mail.replyTo}</>}
            </div>
          </div>
          <button type="button" className="btn btn-quiet" onClick={onClose}>Close</button>
        </div>
        {mail.blocker && <p className="form-problem modal-warn">This bill can&apos;t be sent yet: {mail.blocker}.</p>}
        {/* sandbox with no permissions: the email is shown, never run. */}
        <iframe className="modal-frame" title="Email preview" sandbox="" srcDoc={mail.html} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function blockerOf(b) {
  if (!b.included) return null
  if (!Number.isFinite(b.kwh)) return 'no kWh figure'
  if (!b.to || b.to.length === 0) return 'no email address'
  return null
}

/** Problems first, then ready, then sent, then left out. */
function rank(b) {
  if (b.status === 'failed') return 0
  if (b.included && b.status !== 'sent' && blockerOf(b)) return 1
  if (b.status === 'sending') return 2
  if (b.included && b.status !== 'sent') return 3
  if (b.status === 'sent') return 4
  return 5
}

function fmtKwh(v) {
  return new Intl.NumberFormat('en-PH', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(v)
}

function fmtWhen(ts) {
  const ms = typeof ts === 'number' ? ts : ts?._seconds ? ts._seconds * 1000 : ts?.seconds ? ts.seconds * 1000 : null
  return ms ? new Date(ms).toLocaleString() : ''
}
