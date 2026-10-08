import { useCallback, useEffect, useMemo, useState } from 'react'
import { ref, set } from 'firebase/database'
import { db } from '../firebase'
import { useAuth } from '../hooks/useAuth'
import { useDeviceAccess } from '../hooks/useDeviceAccess'
import { useRtdbValue } from '../hooks/useRtdbValue'
import { useIsAdmin } from '../hooks/useIsAdmin'
import { useDeviceName } from '../hooks/useDeviceName'
import { AlertThresholds } from './AlertThresholds'
import { MallDisplay } from './MallDisplay'
import { GaugeDisplay } from './GaugeDisplay'
import { CompanyPlans } from './CompanyPlans'
import { CompanyManager } from './CompanyManager'
import { SignIn } from './SignIn'

// Renaming stays a short named list of accounts, deliberately - it is a
// labelling tool, not a role. Alert limits are the opposite: setting a
// tenant's load ceiling is an operational act any admin should be able to
// perform. So the PAGE opens for admins, and the name field is disabled
// for anyone who is not this account. Plans are like alert limits: any
// admin, since admins are Instrubyte staff.
//
// Both are only the client-side half. The rules on naming/{deviceId} and
// alertRules/{deviceId} are what actually decide whether a write lands;
// these constants just stop the UI offering something that would fail.
// Keep in step with the naming/$deviceId .write rule.
const NAMING_ACCESS_UIDS = new Set([
  'ROz1Xq3b4yReAPkLNGJCFbj6inV2',
  'ZwULfPBOP2PIMLzOCMKgEZ1RaZC3',
])

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
  const mayRename = NAMING_ACCESS_UIDS.has(user?.uid)
  const knownDevices = useMemo(() => deviceAccess.devices.map((d) => d.id), [deviceAccess.devices])
  const [tab, setTab] = useState(tabFromHash)
  const selectTab = (id) => {
    setTab(id)
    try { window.history.replaceState(null, '', `#${id}`) } catch { /* the tab still switches */ }
  }

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
  if (!realUser) return <SignIn />


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
        <a className="signout-btn admin-back" href="/">&larr; Dashboard</a>
      </header>

      {/* One thing at a time. The page used to be every setting of every
          meter in one scroll; three tabs answer "what am I here to do". */}
      <nav className="ranges admin-tabs" aria-label="Admin sections">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`range-btn ${tab === id ? 'range-active' : ''}`}
            aria-pressed={tab === id}
            onClick={() => selectTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'meters' && (
        <MeterList devices={deviceAccess.devices} loading={deviceAccess.loading} mayRename={mayRename} />
      )}
      {tab === 'malls' && <CompanyManager uid={user.uid} knownDevices={knownDevices} />}
      {tab === 'plans' && <CompanyPlans />}
    </div>
  )
}

const TABS = [['meters', 'Meters'], ['malls', 'Malls'], ['plans', 'Plans']]

// The open tab lives in the address (#malls), so a reload or a shared link
// lands on the same one.
function tabFromHash() {
  const h = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : ''
  return TABS.some(([id]) => id === h) ? h : 'meters'
}

/**
 * Every meter this account can open, grouped by mall and folded shut.
 *
 * Folded for two reasons. Reading: twenty-three meters each showing four
 * blocks of settings is a page nobody can find anything on. And cost: a
 * meter's limits, tags and display choices are only read from the database
 * while that meter is open.
 */
function MeterList({ devices, loading, mayRename }) {
  const companies = useRtdbValue('companies', true)
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState(null)

  const groups = useMemo(() => {
    const byNumber = (x, y) => x.localeCompare(y, undefined, { numeric: true })
    const mine = new Set(devices.map((d) => d.id))
    const placed = new Set()
    const out = []
    const list = Object.entries(companies.data || {})
      .filter(([, c]) => c && typeof c === 'object')
      .map(([id, c]) => ({ id, name: (typeof c.name === 'string' && c.name) || id, devices: Object.keys(c.devices || {}) }))
      // Biggest first: a mall's own entry should claim its meters before a
      // demo group that happens to share one.
      .sort((x, y) => y.devices.length - x.devices.length || x.name.localeCompare(y.name))
    for (const c of list) {
      const ids = c.devices.filter((d) => mine.has(d) && !placed.has(d)).sort(byNumber)
      if (ids.length === 0) continue
      for (const d of ids) placed.add(d)
      out.push({ key: c.id, name: c.name, ids })
    }
    const rest = [...mine].filter((d) => !placed.has(d)).sort(byNumber)
    if (rest.length > 0) out.push({ key: '/none', name: 'Not in a mall', ids: rest })
    return out.sort((x, y) => x.name.localeCompare(y.name))
  }, [companies.data, devices])

  const q = query.trim().toLowerCase()

  return (
    <section>
      <div className="admin-intro">
        <h2>Meters</h2>
        <p className="admin-hint">
          Open a meter to change its name, its alert limits, and how it is shown.
          Alert limits only send notifications — nothing is switched off.
        </p>
        {!mayRename && (
          <p className="admin-hint">Renaming is limited to named accounts, so names are read-only for you.</p>
        )}
        <input
          className="naming-input admin-search"
          type="search"
          value={query}
          placeholder="Find a meter by name or id"
          aria-label="Find a meter"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && <p className="admin-hint">Loading your meters…</p>}
      {!loading && devices.length === 0 && <p className="admin-hint">No meters yet. Add some to a mall on the Malls tab.</p>}

      {groups.map((g) => (
        <MeterGroup
          key={g.key}
          group={g}
          query={q}
          openId={openId}
          onToggle={(id) => setOpenId((cur) => (cur === id ? null : id))}
          mayRename={mayRename}
        />
      ))}
    </section>
  )
}

function MeterGroup({ group, query, openId, onToggle, mayRename }) {
  // Which of its meters match the search is only known once each has
  // looked up its own name, so the rows report back and an empty group
  // hides itself.
  const [hidden, setHidden] = useState({})
  const report = useCallback((id, isHidden) => {
    setHidden((prev) => (Boolean(prev[id]) === isHidden ? prev : { ...prev, [id]: isHidden }))
  }, [])
  const shown = group.ids.filter((id) => !hidden[id]).length

  return (
    <div className="meter-group" hidden={shown === 0}>
      <h3 className="meter-group-title">
        {group.name}
        <span className="meter-group-count">{shown} meter{shown === 1 ? '' : 's'}</span>
      </h3>
      <div className="meter-list">
        {group.ids.map((id) => (
          <MeterItem
            key={id}
            deviceId={id}
            query={query}
            open={openId === id}
            onToggle={onToggle}
            onHidden={report}
            mayRename={mayRename}
          />
        ))}
      </div>
    </div>
  )
}

function MeterItem({ deviceId, query, open, onToggle, onHidden, mayRename }) {
  const { name } = useDeviceName(deviceId)
  const match = !query || deviceId.toLowerCase().includes(query) || String(name).toLowerCase().includes(query)

  useEffect(() => { onHidden(deviceId, !match) }, [deviceId, match, onHidden])
  if (!match) return null

  return (
    <div className={`meter-item${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="meter-head"
        aria-expanded={open}
        onClick={() => onToggle(deviceId)}
      >
        <span className="meter-head-name">{name}</span>
        {name !== deviceId && <span className="meter-head-id">{deviceId}</span>}
        <svg className="picker-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6"
                strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="meter-body">
          <div className="admin-sub admin-sub-first">
            <h4>Name</h4>
            <p className="admin-hint">What everyone sees instead of the id. Clear it to show the id again.</p>
            <NamingRow deviceId={deviceId} mayRename={mayRename} />
          </div>
          <div className="admin-sub">
            <h4>Alert limits</h4>
            <p className="admin-hint">
              Notify when a reading goes below or above a value. Leave a box empty for no alert on
              that side. Sudden jumps are reported by themselves and need no limit.
            </p>
            <AlertThresholds deviceId={deviceId} />
          </div>
          <div className="admin-sub">
            <h4>Dials</h4>
            <GaugeDisplay deviceId={deviceId} />
          </div>
          <div className="admin-sub">
            <h4>Mall page</h4>
            <MallDisplay deviceId={deviceId} />
          </div>
        </div>
      )}
    </div>
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
