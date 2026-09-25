import { useState } from 'react'
import { ref, set, remove } from 'firebase/database'
import { db } from '../firebase'
import { useRtdbValue } from '../hooks/useRtdbValue'

/**
 * Which of a tenant's readings appear on the mall wall.
 *
 * WHY THIS IS CONFIGURABLE AT ALL
 * The tile picked a tag by itself - Current, then Power, then Voltage - and
 * that is a guess about what a landlord cares about. It is right often
 * enough to be a sensible default and wrong often enough to be annoying: a
 * cold store is watched on temperature, a pump on pressure, and neither is
 * in that list.
 *
 * THE FIRST SELECTED TAG BECOMES THE DIAL. The rest appear as plain numbers
 * under it, because a tile with three dials on it is not readable at the
 * size a wall of ninety demands. Selecting nothing keeps the automatic
 * choice rather than blanking the tile - an unconfigured device must still
 * show something.
 *
 * Stored at mallDisplay/{deviceId}/{tagKey} = true, deliberately NOT under
 * devices/{id}/tags: the box rewrites that node on every restart and would
 * erase this with it - the same reason alert thresholds live outside it.
 */
export function MallDisplay({ deviceId }) {
  const tags = useRtdbValue(`devices/${deviceId}/tags`, true)
  const chosen = useRtdbValue(`mallDisplay/${deviceId}`, true)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const tagKeys = Object.keys(tags.data || {}).sort()
  const selected = chosen.data || {}
  const anySelected = Object.values(selected).some(Boolean)

  if (tags.loading) return <p className="admin-hint">Loading tags…</p>

  if (tagKeys.length === 0) {
    return (
      <p className="admin-hint">
        No tags published yet. A device lists its tags once it has pushed at
        least once, so there is nothing to choose from here until it does.
      </p>
    )
  }

  const toggle = async (key) => {
    setBusy(key)
    setError(null)
    try {
      if (selected[key]) await remove(ref(db, `mallDisplay/${deviceId}/${key}`))
      else await set(ref(db, `mallDisplay/${deviceId}/${key}`), true)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="malldisp">
      <p className="admin-hint">
        Pick what this tenant shows on the mall page. The first one ticked is
        drawn as the dial; the others appear as numbers beneath it. Tick
        nothing and the page chooses for you.
      </p>

      {error && <p className="admin-error">Could not save: {error}</p>}

      <div className="malldisp-tags">
        {tagKeys.map((key) => {
          const on = Boolean(selected[key])
          const unit = tags.data?.[key]?.unit || ''
          return (
            <button
              key={key}
              type="button"
              className={`malldisp-tag ${on ? 'is-on' : ''}`}
              onClick={() => toggle(key)}
              disabled={busy === key}
              aria-pressed={on}
            >
              <span className="malldisp-check" aria-hidden="true">{on ? '✓' : ''}</span>
              {key}{unit && <span className="malldisp-unit"> {unit}</span>}
            </button>
          )
        })}
      </div>

      {!anySelected && (
        <p className="admin-hint admin-hint-quiet">
          Nothing ticked — the page is choosing automatically.
        </p>
      )}
    </div>
  )
}
