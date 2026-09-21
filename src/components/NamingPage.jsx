import { useState } from 'react'
import { ref, set } from 'firebase/database'
import { db } from '../firebase'
import { useAuth } from '../hooks/useAuth'
import { useDeviceAccess } from '../hooks/useDeviceAccess'
import { useRtdbValue } from '../hooks/useRtdbValue'
import { useIsAdmin } from '../hooks/useIsAdmin'
import { AlertThresholds } from './AlertThresholds'
import { SignIn } from './SignIn'

// Renaming stays one specific account, deliberately - it is a personal
// labelling tool, not a role. Alert limits are the opposite: setting a
// tenant's load ceiling is an operational act any admin should be able to
// perform. So the PAGE opens for admins, and the name field is disabled
// for anyone who is not this account.
//
// Both are only the client-side half. The rules on naming/{deviceId} and
// alertRules/{deviceId} are what actually decide whether a write lands;
// these constants just stop the UI offering something that would fail.
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
  const isAdmin = useIsAdmin(realUser ? user : null)
  const mayRename = user?.uid === NAMING_ACCESS_UID

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

  if (!isAdmin) {
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
            <span className="masthead-tagline">Admin</span>
          </div>
        </div>
      </header>

      <div className="notice notice-info">
        <h2>Devices and alerts</h2>
        <p>
          <strong>Name</strong> is what everyone signed in sees in place of a
          device's raw id. Clear it and save to go back to showing the id.
        </p>
        <p>
          <strong>Alert thresholds</strong> decide when you get told about a
          reading — for example, notify if voltage drops below 207&nbsp;V, or
          if a tenant draws more than 12&nbsp;A. Leave a field blank for no
          alert on that side.</p>
        <p className="admin-hint">
          These only send notifications. Nothing is switched off, cut or
          restricted — the system reads meters, it does not control supply.
        </p>
        <p className="admin-hint">
          Separate from spike alerts. A spike is a reading far outside a
          tag's own recent range, and is reported whether or not a threshold
          is set here — it needs no configuration and cannot be switched off
          from this page. Thresholds catch a value you have decided to watch
          for; spikes catch a value nobody thought to watch for.
        </p>
        {!mayRename && (
          <p className="admin-hint">
            Renaming is restricted to one account, so the name fields are
            read-only for you. Alert thresholds are editable by any admin.
          </p>
        )}
      </div>

      {deviceAccess.loading && <p>Loading your devices…</p>}

      {!deviceAccess.loading && deviceAccess.devices.length === 0 && (
        <p>No devices to name yet.</p>
      )}

      {!deviceAccess.loading && deviceAccess.devices.length > 0 && (
        <div className="naming-list">
          {deviceAccess.devices.map((d) => (
            <DeviceAdminCard key={d.id} deviceId={d.id} mayRename={mayRename} />
          ))}
        </div>
      )}

      <p><a href="/">&larr; Back to the dashboard</a></p>
    </div>
  )
}

function DeviceAdminCard({ deviceId, mayRename }) {
  return (
    <section className="admin-card">
      <NamingRow deviceId={deviceId} mayRename={mayRename} />
      <AlertThresholds deviceId={deviceId} />
    </section>
  )
}

function NamingRow({ deviceId, mayRename }) {
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
        disabled={!mayRename}
      />
      {mayRename && (
        <button type="button" className="signout-btn naming-save" onClick={save}>
          {saved ? 'Saved' : error ? 'Error' : 'Save'}
        </button>
      )}
      {error && <span className="naming-row-error" role="alert">{error}</span>}
    </div>
  )
}
