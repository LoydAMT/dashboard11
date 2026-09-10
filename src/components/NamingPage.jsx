import { useState } from 'react'
import { ref, set } from 'firebase/database'
import { db } from '../firebase'
import { useAuth } from '../hooks/useAuth'
import { useDeviceAccess } from '../hooks/useDeviceAccess'
import { useRtdbValue } from '../hooks/useRtdbValue'
import { SignIn } from './SignIn'

// Hardcoded on purpose, not a role in the access model (see
// database.rules.json's viewers/operators/admins). This is the client-side
// half of the gate; the rule on naming/{deviceId}'s .write is the half that
// actually matters - this one only decides whether the page bothers to
// render the form, not whether a write would succeed.
const NAMING_ACCESS_UID = 'ROz1Xq3b4yReAPkLNGJCFbj6inV2'

/**
 * /naming - set a device's display name, shared with every signed-in
 * account (see hooks/useDeviceName.js and the naming/{deviceId} rule).
 *
 * Reads the account's own device list the same way the dashboard does
 * (useDeviceAccess). devices/{deviceId} itself is never written here - only
 * naming/{deviceId}, a separate node holding nothing but an optional label.
 * A device with no override still shows its raw id, to this account and
 * every other.
 */
export function NamingPage() {
  const { user, resolved, realUser } = useAuth()
  const deviceAccess = useDeviceAccess(realUser ? user : null)

  if (!resolved) {
    return (
      <div className="app">
        <div className="notice notice-info">
          <h2>Loading…</h2>
          <p>Checking your session.</p>
        </div>
      </div>
    )
  }

  // Distinct from "wrong account" below: this route has to be usable from a
  // cold browser (a fresh session, a private window) the same as the main
  // dashboard is, or the only way to ever reach it would be staying signed
  // in elsewhere first - which defeats visiting it directly.
  if (!realUser) {
    return (
      <div className="app">
        <SignIn />
      </div>
    )
  }

  if (user.uid !== NAMING_ACCESS_UID) {
    return (
      <div className="app">
        <div className="notice">
          <h2>Not available</h2>
          <p>This page is not available for this account.</p>
          <p><a href="/">Back to the dashboard</a></p>
        </div>
      </div>
    )
  }

  return (
    <div className="app naming-page">
      <header className="masthead">
        <div className="masthead-brand">
          <img className="masthead-logo" src="/favicon-48.png" alt="" aria-hidden="true" />
          <div className="masthead-text">
            <h1>INSTRUBYTE</h1>
            <span className="masthead-tagline">Device names</span>
          </div>
        </div>
      </header>

      <div className="notice notice-info">
        <h2>Rename devices</h2>
        <p>
          Sets the name everyone signed in sees in place of a device's raw id
          — this changes naming/&#123;deviceId&#125; only; the device's own
          data and id are untouched. Clear a field and save to remove the
          override and go back to showing the raw id.
        </p>
      </div>

      {deviceAccess.loading && <p>Loading your devices…</p>}

      {!deviceAccess.loading && deviceAccess.devices.length === 0 && (
        <p>No devices to name yet.</p>
      )}

      {!deviceAccess.loading && deviceAccess.devices.length > 0 && (
        <div className="naming-list">
          {deviceAccess.devices.map((d) => (
            <NamingRow key={d.id} deviceId={d.id} />
          ))}
        </div>
      )}

      <p><a href="/">&larr; Back to the dashboard</a></p>
    </div>
  )
}

function NamingRow({ deviceId }) {
  const node = useRtdbValue(`naming/${deviceId}`, true)

  // null = "untouched this session, show whatever naming/{deviceId} holds
  // once it loads". Once the field is edited it becomes a real string
  // (possibly '') and takes over as the source of truth, so a listener
  // update arriving mid-edit can never clobber what is being typed.
  const [draft, setDraft] = useState(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  const value = draft ?? node.data ?? ''

  const save = async () => {
    const trimmed = value.trim()
    setError(null)
    try {
      // null deletes the key outright - naming/{deviceId} not existing and
      // naming/{deviceId} being an empty string must never be the same
      // state to store, only the same state to display (see useDeviceName).
      await set(ref(db, `naming/${deviceId}`), trimmed || null)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (err) {
      setError(err?.message || String(err))
    }
  }

  return (
    <div className="naming-row">
      <div className="naming-row-id">{deviceId}</div>
      <input
        type="text"
        className="naming-input"
        value={value}
        onChange={(e) => { setDraft(e.target.value); setSaved(false); setError(null) }}
        onKeyDown={(e) => { if (e.key === 'Enter') save() }}
        placeholder={deviceId}
        aria-label={`Display name for ${deviceId}`}
      />
      <button type="button" className="signout-btn naming-save" onClick={save}>
        {saved ? 'Saved' : error ? 'Error' : 'Save'}
      </button>
      {error && <span className="naming-row-error" role="alert">{error}</span>}
    </div>
  )
}
