import { useEffect, useMemo, useState } from 'react'
import { ref, update } from 'firebase/database'
import { db } from '../firebase'
import { useRtdbValue } from '../hooks/useRtdbValue'
import { useDeviceName } from '../hooks/useDeviceName'
import { fetchRtdbRest } from '../lib/restdb'

/**
 * Create a mall and choose which meters belong to it.
 *
 * A "mall" is a company: a name and a list of device ids under
 * companies/{id}. projectCompanyAccess watches that node and re-derives who
 * can open which meter, so a change here reaches the dashboard within
 * seconds of Save.
 *
 * WHAT THIS PAGE CAN AND CANNOT WRITE (database.rules.json)
 *   companies/{id}/name               an admin
 *   companies/{id}/devices/{device}   an admin; true, or removed
 *   companyMembers/{id}/{admin uid}   an admin, for ADMINS only
 * The last one is why a new mall shows up for every admin: all of them are
 * added as its operators in the same write. Adding a CUSTOMER is still done
 * server-side - a member list is every colleague's account id, and finding
 * one by email needs the Admin SDK - so there is no member editor here.
 *
 * There is no delete either. Removing a mall removes people's access to
 * every meter in it; emptying its meter list has the same effect and can be
 * undone.
 */
export function CompanyManager({ uid, knownDevices = [] }) {
  const companies = useRtdbValue('companies', true)
  // Every admin, so a new mall is theirs too. If this cannot be read the
  // creator alone is added, which is what the page did before.
  const admins = useRtdbValue('admins', true)
  const adminUids = useMemo(() => {
    const ids = Object.entries(admins.data || {}).filter(([, v]) => v === true).map(([id]) => id)
    return ids.includes(uid) ? ids : [...ids, uid]
  }, [admins.data, uid])

  const list = useMemo(
    () => Object.entries(companies.data || {})
      .filter(([, c]) => c && typeof c === 'object')
      .map(([id, c]) => ({
        id,
        name: typeof c.name === 'string' && c.name ? c.name : id,
        devices: Object.keys(c.devices || {}).sort(byNumber),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [companies.data],
  )

  // EVERY device that has ever published, mall or no mall - so a box that
  // has just been switched on can be put in a mall by ticking it. One
  // shallow REST read: ids only, never what is stored under them (a plain
  // read of devices/ would download every meter's history). Re-read each
  // time this tab is opened, which is when a new box is being looked for.
  const [published, setPublished] = useState([])
  const [listError, setListError] = useState(null)
  useEffect(() => {
    let live = true
    fetchRtdbRest('devices', { shallow: 'true' })
      .then((ids) => { if (live) setPublished(Object.keys(ids || {})) })
      .catch((err) => { if (live) setListError(err?.message || String(err)) })
    return () => { live = false }
  }, [])

  // In some mall already, as opposed to published but unassigned.
  const assigned = useMemo(() => {
    const s = new Set()
    for (const c of list) for (const d of c.devices) s.add(d)
    return s
  }, [list])

  const allDevices = useMemo(() => {
    const ids = new Set([...knownDevices, ...published, ...assigned])
    return [...ids].sort(byNumber)
  }, [knownDevices, published, assigned])

  const unassignedCount = allDevices.filter((d) => !assigned.has(d)).length

  return (
    <section className="admin-card">
      <h3 className="plans-title">Malls</h3>
      <p className="admin-hint">
        A mall is a group of meters that share one overview page. Create one,
        then tick the meters that belong to it. A meter can be in more than
        one mall.
      </p>

      <NewCompany adminUids={adminUids} existingIds={list.map((c) => c.id)} />

      {unassignedCount > 0 && (
        <p className="admin-hint">
          {unassignedCount} meter{unassignedCount === 1 ? ' is' : 's are'} not in any mall yet
          {' '}- marked <span className="company-device-free">no mall</span> in the lists below.
        </p>
      )}
      {listError && (
        <p className="admin-hint">Could not list every device ({listError}); showing the ones already in a mall.</p>
      )}

      {companies.error && (
        <p className="naming-row-error" role="alert">
          Could not read malls: {companies.error.message || String(companies.error)}
        </p>
      )}
      {companies.loading && <p className="admin-hint">Loading malls…</p>}

      {list.length > 0 && (
        <div className="plan-list">
          {list.map((c) => <CompanyRow key={c.id} company={c} allDevices={allDevices} assigned={assigned} />)}
        </div>
      )}
    </section>
  )
}

function NewCompany({ adminUids, existingIds }) {
  const [name, setName] = useState('')
  const [state, setState] = useState(null)   // 'saving' | 'error'
  const [error, setError] = useState(null)

  const trimmed = name.trim()
  const create = async () => {
    if (!trimmed) return
    const id = uniqueId(slug(trimmed), existingIds)
    setState('saving'); setError(null)
    try {
      // One write: the mall, and every admin as its operator - without
      // that, not even the person who made it could see it.
      const changes = { [`companies/${id}/name`]: trimmed }
      for (const a of adminUids) changes[`companyMembers/${id}/${a}`] = 'operator'
      await update(ref(db), changes)
      setName(''); setState(null)
    } catch (err) {
      setState('error'); setError(err?.message || String(err))
    }
  }

  return (
    <div className="naming-row company-new">
      <input
        className="naming-input"
        type="text"
        value={name}
        maxLength={80}
        placeholder="New mall name, e.g. Ayala Central Bloc"
        aria-label="New mall name"
        onChange={(e) => { setName(e.target.value); setState(null); setError(null) }}
        onKeyDown={(e) => { if (e.key === 'Enter') create() }}
      />
      <button
        type="button"
        className="signout-btn naming-save"
        onClick={create}
        disabled={!trimmed || state === 'saving'}
      >
        {state === 'saving' ? 'Creating…' : 'Create mall'}
      </button>
      {error && <span className="naming-row-error" role="alert">{error}</span>}
    </div>
  )
}

function CompanyRow({ company, allDevices, assigned }) {
  const [open, setOpen] = useState(false)
  // null = untouched, follow the database - the same pattern the plan and
  // name fields use, so a change made elsewhere shows up here unprompted.
  const [nameDraft, setNameDraft] = useState(null)
  const [picked, setPicked] = useState(null)       // Set of device ids, or null
  const [extra, setExtra] = useState([])           // ids typed in by hand
  const [typed, setTyped] = useState('')
  const [state, setState] = useState(null)         // 'saved' | 'error'
  const [error, setError] = useState(null)

  const name = nameDraft ?? company.name
  const saved = useMemo(() => new Set(company.devices), [company.devices])
  const chosen = picked ?? saved
  const options = useMemo(
    () => [...new Set([...allDevices, ...extra])].sort(byNumber),
    [allDevices, extra],
  )

  const added = [...chosen].filter((d) => !saved.has(d))
  const removed = [...saved].filter((d) => !chosen.has(d))
  const renamed = name.trim() !== company.name && name.trim() !== ''
  const dirty = renamed || added.length > 0 || removed.length > 0

  const touch = () => { setState(null); setError(null) }
  const toggle = (id) => {
    const next = new Set(chosen)
    if (next.has(id)) next.delete(id); else next.add(id)
    setPicked(next); touch()
  }
  const addTyped = () => {
    const id = typed.trim()
    // The characters a database key cannot contain.
    if (!id || /[.#$[\]/\s]/.test(id)) { setError('A device id cannot contain spaces or . # $ [ ] /'); return }
    setExtra((prev) => (prev.includes(id) ? prev : [...prev, id]))
    const next = new Set(chosen); next.add(id)
    setPicked(next); setTyped(''); touch()
  }

  const save = async () => {
    const changes = {}
    if (renamed) changes[`companies/${company.id}/name`] = name.trim()
    for (const d of added) changes[`companies/${company.id}/devices/${d}`] = true
    for (const d of removed) changes[`companies/${company.id}/devices/${d}`] = null
    setError(null)
    try {
      await update(ref(db), changes)
      setNameDraft(null); setPicked(null); setExtra([])
      setState('saved')
      setTimeout(() => setState(null), 1500)
    } catch (err) {
      setState('error'); setError(err?.message || String(err))
    }
  }

  const n = company.devices.length
  return (
    <div className="naming-row plan-row company-row">
      <div className="plan-row-name">
        <span className="plan-row-label">{company.name}</span>
        <span className="plan-row-meta">
          {company.id} · {n} meter{n === 1 ? '' : 's'}
        </span>
      </div>

      <button
        type="button"
        className="signout-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Close' : 'Edit meters'}
      </button>

      {open && (
        <div className="company-edit">
          <label className="company-field">
            <span>Name</span>
            <input
              className="naming-input"
              type="text"
              value={name}
              maxLength={80}
              onChange={(e) => { setNameDraft(e.target.value); touch() }}
            />
          </label>

          <div className="company-devices" role="group" aria-label={`Meters in ${company.name}`}>
            {options.length === 0 && <p className="admin-hint">No meters known yet. Add one by id below.</p>}
            {options.map((id) => (
              <DeviceOption key={id} deviceId={id} checked={chosen.has(id)} onToggle={toggle} free={!assigned.has(id)} />
            ))}
          </div>

          <div className="company-add">
            <input
              className="naming-input"
              type="text"
              value={typed}
              placeholder="Add a meter by its device id"
              aria-label="Device id to add"
              onChange={(e) => { setTyped(e.target.value); touch() }}
              onKeyDown={(e) => { if (e.key === 'Enter') addTyped() }}
            />
            <button type="button" className="signout-btn" onClick={addTyped} disabled={!typed.trim()}>
              Add
            </button>
          </div>

          <div className="company-save">
            {/* Says what Save will do before it is pressed: removing a meter
                takes it away from everyone who sees this mall. */}
            <span className="admin-hint">
              {dirty
                ? [
                    renamed && 'rename',
                    added.length > 0 && `add ${added.length}`,
                    removed.length > 0 && `remove ${removed.length}`,
                  ].filter(Boolean).join(', ')
                : `${chosen.size} selected`}
            </span>
            <button
              type="button"
              className="signout-btn naming-save"
              onClick={save}
              disabled={!dirty && state !== 'error'}
            >
              {state === 'saved' ? 'Saved' : state === 'error' ? 'Error' : 'Save'}
            </button>
          </div>
          {error && <span className="naming-row-error" role="alert">{error}</span>}
        </div>
      )}
    </div>
  )
}

// A component per meter, because each needs its own name lookup and hooks
// cannot be called in a loop whose length changes.
function DeviceOption({ deviceId, checked, onToggle, free }) {
  const { name } = useDeviceName(deviceId)
  return (
    <label className="company-device">
      <input type="checkbox" checked={checked} onChange={() => onToggle(deviceId)} />
      <span className="company-device-name">{name}</span>
      {name !== deviceId && <span className="company-device-id">{deviceId}</span>}
      {free && <span className="company-device-free">no mall</span>}
    </label>
  )
}

/** "ayala-box1-9" before "ayala-box1-10". */
const byNumber = (a, b) => a.localeCompare(b, undefined, { numeric: true })

/** A database-safe id from a name: "Ayala EE IT Services" -> "ayala-ee-it-services". */
function slug(name) {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'mall'
}

function uniqueId(base, taken) {
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}
