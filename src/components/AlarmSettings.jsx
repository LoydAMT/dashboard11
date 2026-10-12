import { useMemo, useState } from 'react'
import { ref, set, update } from 'firebase/database'
import { db } from '../firebase'
import { useRtdbValue } from '../hooks/useRtdbValue'
import { useDeviceName } from '../hooks/useDeviceName'

/**
 * Alarms for a whole mall on one screen: every meter's alert limits, and
 * what the mall's Telegram group is told about.
 *
 * The Meters tab sets the same limits one meter at a time, which is the
 * wrong tool for fifty-five of them. Here a mall is a table - one row per
 * meter, one reading at a time - with a row at the top that fills every
 * meter at once.
 *
 * WHAT IS WRITTEN (database.rules.json)
 *   alertRules/{device}/{tag}   { lo, hi } - the same node the Meters tab
 *                               and the boxes use. A box picks a change up
 *                               by itself within a few minutes.
 *   telegramNotify/{company}    'limits' | 'all', or absent for off. Read by
 *                               the server when a box reports an alert
 *                               (functions/telegram.js).
 *
 * NOTHING IS ENFORCED. A limit decides when someone is told; no supply is
 * cut and nothing is switched off.
 */
export function AlarmSettings() {
  const companies = useRtdbValue('companies', true)
  // One read for every meter's limits, not one per meter.
  const rules = useRtdbValue('alertRules', true)
  const notify = useRtdbValue('telegramNotify', true)

  const malls = useMemo(
    () => Object.entries(companies.data || {})
      .filter(([, c]) => c && typeof c === 'object' && c.devices)
      .map(([id, c]) => ({
        id,
        name: typeof c.name === 'string' && c.name ? c.name : id,
        devices: Object.keys(c.devices).sort(byNumber),
      }))
      .filter((m) => m.devices.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [companies.data],
  )

  return (
    <section>
      <div className="admin-intro">
        <h2>Alarms</h2>
        <p className="admin-hint">
          Set when each meter raises an alarm, and what is sent to the Telegram group.
          An alarm only notifies — nothing is switched off.
        </p>
      </div>

      {companies.error && (
        <p className="naming-row-error" role="alert">
          Could not read malls: {companies.error.message || String(companies.error)}
        </p>
      )}
      {companies.loading && <p className="admin-hint">Loading malls…</p>}
      {!companies.loading && malls.length === 0 && (
        <p className="admin-hint">No malls with meters yet. Add some on the Malls tab.</p>
      )}

      <div className="plan-list">
        {malls.map((m) => (
          <MallAlarms
            key={m.id}
            mall={m}
            rules={rules.data || {}}
            mode={notify.data?.[m.id] || 'off'}
          />
        ))}
      </div>
    </section>
  )
}

const MODES = [
  ['off', 'Off'],
  ['limits', 'Limits only'],
  ['all', 'Limits and spikes'],
]

const MODE_HINT = {
  off: 'Nothing from this mall is sent to Telegram. Alarms still show on the dashboard.',
  limits: 'A message when a reading goes past its limit. Spikes stay on the dashboard only.',
  all: 'A message when a reading goes past its limit, and when one jumps suddenly.',
}

function MallAlarms({ mall, rules, mode }) {
  const [open, setOpen] = useState(false)
  const [modeError, setModeError] = useState(null)

  const setMode = async (next) => {
    setModeError(null)
    try {
      await set(ref(db, `telegramNotify/${mall.id}`), next === 'off' ? null : next)
    } catch (err) {
      setModeError(err?.message || String(err))
    }
  }

  const withLimits = mall.devices.filter((d) => rules[d] && Object.keys(rules[d]).length > 0).length

  return (
    <div className="naming-row plan-row company-row alarm-mall">
      <div className="plan-row-name">
        <span className="plan-row-label">{mall.name}</span>
        <span className="plan-row-meta">
          {withLimits} of {mall.devices.length} meter{mall.devices.length === 1 ? '' : 's'} have a limit
        </span>
      </div>

      <button type="button" className="signout-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Close' : 'Set limits'}
      </button>

      <div className="alarm-telegram">
        <span className="alarm-telegram-label">Telegram</span>
        <div className="ranges" role="group" aria-label={`Telegram messages for ${mall.name}`}>
          {MODES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`range-btn ${mode === id ? 'range-active' : ''}`}
              aria-pressed={mode === id}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="admin-hint alarm-telegram-hint">{MODE_HINT[mode] || MODE_HINT.off}</p>
        {modeError && <span className="naming-row-error" role="alert">{modeError}</span>}
      </div>

      {open && <MallLimits mall={mall} rules={rules} />}
    </div>
  )
}

/**
 * The limits table for one mall, one reading at a time.
 *
 * Edits are held here until Save, then written together in a single
 * request - fifty-five meters is one write, not fifty-five.
 */
function MallLimits({ mall, rules }) {
  // The readings on offer come from the first meter: every meter on a box
  // runs the same script, so they publish the same tags. One small read,
  // only while the mall is open.
  const tags = useRtdbValue(`devices/${mall.devices[0]}/tags`, true)
  const tagKeys = useMemo(() => {
    const keys = Object.keys(tags.data || {})
    // Readings a limit makes sense on first; a meter total only ever rises.
    return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  }, [tags.data])

  const [picked, setPicked] = useState(null)
  const tagKey = picked && tagKeys.includes(picked) ? picked : tagKeys[0] || null
  const unit = (tagKey && tags.data?.[tagKey]?.unit) || ''

  // { [tagKey]: { [deviceId]: { lo?: string, hi?: string } } } - only what
  // has been typed. Kept per reading so switching tabs loses nothing.
  const [drafts, setDrafts] = useState({})
  const [all, setAll] = useState({ lo: '', hi: '' })
  const [state, setState] = useState(null)   // 'saving' | 'saved' | 'error'
  const [error, setError] = useState(null)

  const touch = () => { setState(null); setError(null) }
  const edit = (deviceId, side, value) => {
    setDrafts((prev) => ({
      ...prev,
      [tagKey]: { ...prev[tagKey], [deviceId]: { ...prev[tagKey]?.[deviceId], [side]: value } },
    }))
    touch()
  }

  const shown = (deviceId, side) => {
    const typed = drafts[tagKey]?.[deviceId]?.[side]
    if (typed !== undefined) return typed
    const stored = rules[deviceId]?.[tagKey]?.[side]
    return stored != null ? String(stored) : ''
  }

  // Fills the table; nothing is written until Save, so a wrong number is
  // corrected or abandoned without having reached a single box.
  const applyAll = () => {
    setDrafts((prev) => {
      const forTag = { ...prev[tagKey] }
      for (const d of mall.devices) forTag[d] = { lo: all.lo, hi: all.hi }
      return { ...prev, [tagKey]: forTag }
    })
    touch()
  }

  const dirtyCount = Object.values(drafts).reduce((n, byDevice) => n + Object.keys(byDevice || {}).length, 0)

  const save = async () => {
    const changes = {}
    for (const [tag, byDevice] of Object.entries(drafts)) {
      for (const [deviceId, d] of Object.entries(byDevice || {})) {
        const stored = rules[deviceId]?.[tag] || {}
        const lo = numOrNull(d.lo !== undefined ? d.lo : stored.lo ?? '')
        const hi = numOrNull(d.hi !== undefined ? d.hi : stored.hi ?? '')
        if (lo === undefined || hi === undefined) {
          setState('error'); setError(`${deviceId} (${tag}): limits must be numbers.`); return
        }
        // Checked here as well as in the database rule, so the reason
        // arrives as words rather than as a refused write.
        if (lo != null && hi != null && lo >= hi) {
          setState('error'); setError(`${deviceId} (${tag}): the lower value must be below the upper one.`); return
        }
        const next = {}
        if (lo != null) next.lo = lo
        if (hi != null) next.hi = hi
        // Both empty removes the node: "never set" and "set to nothing" are
        // the same thing to a box.
        changes[`alertRules/${deviceId}/${tag}`] = Object.keys(next).length > 0 ? next : null
      }
    }
    if (Object.keys(changes).length === 0) return
    setState('saving'); setError(null)
    try {
      await update(ref(db), changes)
      setDrafts({})
      setState('saved')
      setTimeout(() => setState(null), 1500)
    } catch (err) {
      setState('error'); setError(err?.message || String(err))
    }
  }

  if (tags.loading) return <div className="company-edit"><p className="admin-hint">Loading readings…</p></div>
  if (!tagKey) {
    return (
      <div className="company-edit">
        <p className="admin-hint">
          This mall&apos;s meters have not published their readings yet, so there is nothing to set a limit on.
        </p>
      </div>
    )
  }

  return (
    <div className="company-edit">
      <div className="ranges alarm-tags" role="group" aria-label="Reading">
        {tagKeys.map((k) => (
          <button
            key={k}
            type="button"
            className={`range-btn ${tagKey === k ? 'range-active' : ''}`}
            aria-pressed={tagKey === k}
            onClick={() => setPicked(k)}
          >
            {k}
          </button>
        ))}
      </div>

      <div className="alarm-all">
        <span className="alarm-all-label">All {mall.devices.length} meters</span>
        <LimitInput
          value={all.lo} label={`Alert below, every meter, ${tagKey}`} placeholder="below"
          onChange={(v) => setAll((p) => ({ ...p, lo: v }))}
        />
        <LimitInput
          value={all.hi} label={`Alert above, every meter, ${tagKey}`} placeholder="above"
          onChange={(v) => setAll((p) => ({ ...p, hi: v }))}
        />
        <button type="button" className="signout-btn" onClick={applyAll}>Fill all</button>
      </div>

      <table className="thresholds-table alarm-table">
        <thead>
          <tr>
            <th>Meter</th>
            <th>Alert below{unit ? ` (${unit})` : ''}</th>
            <th>Alert above{unit ? ` (${unit})` : ''}</th>
          </tr>
        </thead>
        <tbody>
          {mall.devices.map((d) => (
            <LimitRow
              key={d}
              deviceId={d}
              tagKey={tagKey}
              lo={shown(d, 'lo')}
              hi={shown(d, 'hi')}
              edited={Boolean(drafts[tagKey]?.[d])}
              onEdit={edit}
            />
          ))}
        </tbody>
      </table>

      <div className="company-save alarm-save">
        <span className="admin-hint">
          {dirtyCount > 0
            ? `${dirtyCount} change${dirtyCount === 1 ? '' : 's'} not saved yet`
            : 'Leave a box empty for no alarm on that side.'}
        </span>
        {dirtyCount > 0 && (
          <button type="button" className="signout-btn" onClick={() => { setDrafts({}); touch() }}>
            Discard
          </button>
        )}
        <button
          type="button"
          className="signout-btn naming-save"
          onClick={save}
          disabled={dirtyCount === 0 || state === 'saving'}
        >
          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? 'Try again' : 'Save'}
        </button>
      </div>
      {error && <span className="naming-row-error" role="alert">{error}</span>}
    </div>
  )
}

// A component per meter, because each needs its own name lookup and hooks
// cannot be called in a loop whose length changes.
function LimitRow({ deviceId, tagKey, lo, hi, edited, onEdit }) {
  const { name } = useDeviceName(deviceId)
  return (
    <tr className={`thresholds-row${lo !== '' || hi !== '' ? ' is-set' : ''}${edited ? ' is-edited' : ''}`}>
      <td className="thresholds-tag alarm-meter">{name}</td>
      <td data-label="Alert below">
        <LimitInput value={lo} label={`Alert below for ${name}, ${tagKey}`} onChange={(v) => onEdit(deviceId, 'lo', v)} />
      </td>
      <td data-label="Alert above">
        <LimitInput value={hi} label={`Alert above for ${name}, ${tagKey}`} onChange={(v) => onEdit(deviceId, 'hi', v)} />
      </td>
    </tr>
  )
}

function LimitInput({ value, label, onChange, placeholder = '—' }) {
  return (
    <input
      type="text" inputMode="decimal" className="thresholds-input"
      value={value} placeholder={placeholder} aria-label={label}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

// '' -> null (no limit), a number -> it, anything else -> undefined (typed,
// but not a number).
const numOrNull = (s) => {
  const t = String(s).trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** "ayala-box1-9" before "ayala-box1-10". */
const byNumber = (a, b) => a.localeCompare(b, undefined, { numeric: true })

/** Current and Voltage lead; a running total goes last. */
const rank = (key) => (key === 'Current' ? 0 : key === 'Voltage' ? 1 : /kwh|total/i.test(key) ? 9 : 5)
