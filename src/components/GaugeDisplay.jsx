import { useState } from 'react'
import { ref, set, remove } from 'firebase/database'
import { db } from '../firebase'
import { useRtdbValue } from '../hooks/useRtdbValue'

/**
 * Which of a device's tag cards draw a dial on the dashboard.
 *
 * WHY THIS IS CONFIGURABLE
 * A dial answers "where is this reading inside its normal range". For most
 * tags that is the right question; for some it is meaningless. A totalizer
 * only ever rises, so a dial scaled to its recent readings shows the needle
 * creeping along an arc that says nothing - the number is the whole story.
 * Nothing in the data distinguishes "accumulator" from "measurement"
 * reliably, so the choice is a person's to make, per tag.
 *
 * Stored at gaugeOff/{deviceId}/{tagKey} = true, and only for tags whose
 * dial is OFF. On is the default and is stored as absence, so every existing
 * tag keeps its dial without anyone touching this page, and a tag that
 * appears later gets one too. Kept outside devices/{id}/tags for the same
 * reason as alert thresholds: the box rewrites that node on every restart.
 */
export function GaugeDisplay({ deviceId }) {
  const tags = useRtdbValue(`devices/${deviceId}/tags`, true)
  const off = useRtdbValue(`gaugeOff/${deviceId}`, true)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const tagKeys = Object.keys(tags.data || {}).sort()
  const offKeys = off.data || {}

  if (tags.loading) return <p className="admin-hint">Loading tags…</p>

  if (tagKeys.length === 0) {
    return (
      <p className="admin-hint">
        No tags published yet. A device lists its tags once it has pushed at
        least once, so there is nothing to choose from here until it does.
      </p>
    )
  }

  const choose = async (key, gaugeOn) => {
    if (gaugeOn === !offKeys[key]) return   // already in that state
    setBusy(key)
    setError(null)
    try {
      if (gaugeOn) await remove(ref(db, `gaugeOff/${deviceId}/${key}`))
      else await set(ref(db, `gaugeOff/${deviceId}/${key}`), true)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="gaugedisp">
      <p className="admin-hint">
        Turn a tag's dial off where a dial says nothing - a totalizer that only
        ever rises, for example. Its card then shows the reading as a plain
        number. Applies to everyone who views this device.
      </p>

      {error && <p className="admin-error">Could not save: {error}</p>}

      <div className="gaugedisp-rows">
        {tagKeys.map((key) => {
          const on = !offKeys[key]
          const unit = tags.data?.[key]?.unit || ''
          const name = tags.data?.[key]?.name || key
          return (
            <div key={key} className="gaugedisp-row">
              <span className="gaugedisp-name">
                {name}{unit && <span className="malldisp-unit"> {unit}</span>}
              </span>
              <div className="seg" role="group" aria-label={`Dial for ${name}`}>
                <button
                  type="button"
                  className={on ? 'is-on' : ''}
                  aria-pressed={on}
                  disabled={busy === key}
                  onClick={() => choose(key, true)}
                >
                  On
                </button>
                <button
                  type="button"
                  className={on ? '' : 'is-on'}
                  aria-pressed={!on}
                  disabled={busy === key}
                  onClick={() => choose(key, false)}
                >
                  Off
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
