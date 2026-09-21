import { useState } from 'react'
import { ref, set, remove } from 'firebase/database'
import { db } from '../firebase'
import { useRtdbValue } from '../hooks/useRtdbValue'

/**
 * Alert limits for one device, one row per tag.
 *
 * A limit says "tell me when this reading leaves the band I consider
 * acceptable" - a voltage floor, a tenant's agreed load ceiling. It is a
 * statement about what is ALLOWED.
 *
 * That is a different question from the spike detector, which asks whether
 * a reading is UNUSUAL for this tag against its own recent behaviour. The
 * spike detector needs no configuration and is not editable here; it runs
 * on every tag whether or not a limit exists. Both are explained on the
 * page so nobody sets a limit expecting it to replace the other.
 *
 * Limits live at alertRules/{deviceId}/{tagKey}, not under the device's own
 * tags/ node - the box rewrites that node on every restart and would erase
 * anything stored beside it.
 */
export function AlertLimits({ deviceId }) {
  const tags = useRtdbValue(`devices/${deviceId}/tags`, true)
  const rules = useRtdbValue(`alertRules/${deviceId}`, true)

  const tagKeys = Object.keys(tags.data || {}).sort()

  if (tags.loading) return <p className="admin-hint">Loading tags…</p>

  if (tagKeys.length === 0) {
    return (
      <p className="admin-hint">
        No tags published yet. A device only lists its tags once it has
        connected and sent them, so there is nothing to set limits on until
        then.
      </p>
    )
  }

  return (
    <table className="limits-table">
      <thead>
        <tr>
          <th>Tag</th>
          <th>Low limit</th>
          <th>High limit</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {tagKeys.map((key) => (
          <LimitRow
            key={key}
            deviceId={deviceId}
            tagKey={key}
            unit={tags.data?.[key]?.unit || ''}
            rule={rules.data?.[key] || null}
          />
        ))}
      </tbody>
    </table>
  )
}

const numOrNull = (s) => {
  const t = String(s).trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined   // undefined = typed, not a number
}

function LimitRow({ deviceId, tagKey, unit, rule }) {
  // null means "not edited this session" so a live update can land without
  // overwriting what is being typed. Same pattern as the name field.
  const [loDraft, setLoDraft] = useState(null)
  const [hiDraft, setHiDraft] = useState(null)
  const [state, setState] = useState(null)   // 'saved' | 'error'
  const [error, setError] = useState(null)

  const lo = loDraft ?? (rule?.lo != null ? String(rule.lo) : '')
  const hi = hiDraft ?? (rule?.hi != null ? String(rule.hi) : '')
  const dirty = loDraft !== null || hiDraft !== null

  const save = async () => {
    setError(null)
    const loVal = numOrNull(lo)
    const hiVal = numOrNull(hi)

    if (loVal === undefined || hiVal === undefined) {
      setState('error'); setError('Limits must be numbers.'); return
    }
    // Checked here as well as in the database rule. The rule is the real
    // boundary; this exists so the reason arrives immediately instead of as
    // a permission error that says nothing about what was wrong.
    if (loVal != null && hiVal != null && loVal >= hiVal) {
      setState('error'); setError('The low limit must be below the high limit.'); return
    }

    const next = {}
    if (loVal != null) next.lo = loVal
    if (hiVal != null) next.hi = hiVal

    try {
      // Both fields cleared means "no limits on this tag" - remove the node
      // entirely rather than store an empty object, so "never configured"
      // and "configured with nothing" cannot drift apart.
      if (Object.keys(next).length === 0) {
        await remove(ref(db, `alertRules/${deviceId}/${tagKey}`))
      } else {
        await set(ref(db, `alertRules/${deviceId}/${tagKey}`), next)
      }
      setLoDraft(null); setHiDraft(null)
      setState('saved')
      setTimeout(() => setState(null), 1500)
    } catch (err) {
      setState('error')
      setError(err?.message || String(err))
    }
  }

  const onEdit = (setter) => (e) => {
    setter(e.target.value); setState(null); setError(null)
  }

  const active = rule && (rule.lo != null || rule.hi != null)

  return (
    <tr className={active ? 'limits-row is-set' : 'limits-row'}>
      <td className="limits-tag">
        {tagKey}
        {unit && <span className="limits-unit"> ({unit})</span>}
        {!active && <span className="limits-off"> no limits set</span>}
      </td>
      <td>
        <input
          type="text" inputMode="decimal" className="limits-input"
          value={lo} onChange={onEdit(setLoDraft)}
          onKeyDown={(e) => { if (e.key === 'Enter') save() }}
          placeholder="—" aria-label={`Low limit for ${tagKey}`}
        />
      </td>
      <td>
        <input
          type="text" inputMode="decimal" className="limits-input"
          value={hi} onChange={onEdit(setHiDraft)}
          onKeyDown={(e) => { if (e.key === 'Enter') save() }}
          placeholder="—" aria-label={`High limit for ${tagKey}`}
        />
      </td>
      <td className="limits-actions">
        <button
          type="button"
          className="signout-btn"
          onClick={save}
          disabled={!dirty && state !== 'error'}
        >
          {state === 'saved' ? 'Saved' : state === 'error' ? 'Error' : 'Save'}
        </button>
        {error && <div className="limits-error" role="alert">{error}</div>}
      </td>
    </tr>
  )
}
