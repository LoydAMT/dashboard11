import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchAlerts, fetchCompanyAlerts } from '../lib/alertsApi'

/**
 * The alert log with its filters - shared by a tenant's own history and the
 * mall-wide one, so both filter the same way.
 *
 * EVERY FILTER RUNS ON THE SERVER. The previous chips filtered whatever page
 * the browser already held, which quietly answers the wrong question: pick
 * one tenant and you got that tenant's alerts from among the latest 200
 * mall-wide, presented as if it were their history. The server reads on
 * until it has a page of matches, and when it stops short it says how far
 * back it looked instead of implying that was everything.
 */

// What people actually ask for, rather than the engine's internal kinds.
// "Recovered" gathers the two all-clear events so a problems-only view is
// one click (leave it off) instead of four.
const KIND_GROUPS = [
  { id: 'threshold', label: 'Threshold', kinds: ['alarm-high', 'alarm-low'], tone: 'critical' },
  { id: 'offline', label: 'Offline', kinds: ['offline'], tone: 'critical' },
  { id: 'spike', label: 'Spike', kinds: ['spike'], tone: 'warning' },
  { id: 'recovered', label: 'Recovered', kinds: ['alarm-clear', 'online'], tone: 'info' },
]

const KIND_LABEL = {
  'alarm-high': 'Above threshold',
  'alarm-low': 'Below threshold',
  'alarm-clear': 'Back to normal',
  spike: 'Spike',
  offline: 'Offline',
  online: 'Back online',
}

const RANGES = [
  { id: '24h', label: '24 hours', ms: 86400000 },
  { id: '7d', label: '7 days', ms: 7 * 86400000 },
  { id: '30d', label: '30 days', ms: 30 * 86400000 },
  { id: 'all', label: 'All time', ms: null },
  { id: 'custom', label: 'Custom', ms: null },
]

/**
 * @param scope     { company } for the mall-wide log, { device } for one
 * @param tenants   [{ id, name }] - company scope only; enables the tenant
 *                  picker and names each row
 * @param readings  tag keys to offer as a reading filter
 * @param nowMs     the app's ticking clock, for "Today" / "Yesterday"
 */
export function AlertLog({ scope, tenants = [], readings = [], nowMs, onOpenDevice }) {
  const isCompany = Boolean(scope.company)
  const [range, setRange] = useState({ id: 'all', since: null, until: null })
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [groups, setGroups] = useState([])      // KIND_GROUPS ids; none = all
  const [devices, setDevices] = useState([])    // device ids; none = all
  const [tags, setTags] = useState([])          // tag keys; none = all
  const [refreshes, setRefreshes] = useState(0)

  const names = useMemo(() => Object.fromEntries(tenants.map((t) => [t.id, t.name])), [tenants])

  const kinds = KIND_GROUPS.filter((g) => groups.includes(g.id)).flatMap((g) => g.kinds)
  const active = groups.length + devices.length + tags.length + (range.id === 'all' ? 0 : 1)

  // Relative ranges are anchored at the moment they are CHOSEN and then
  // held, rather than recomputed from the clock on every render - which
  // would slide the window forward each second and remount the results.
  // nowMs is the app's own ticking clock, so no second clock is read here.
  const pickRange = (id) => {
    const r = RANGES.find((x) => x.id === id)
    if (id === 'custom') {
      setRange(customRange(customFrom, customTo))
      return
    }
    setRange({ id, since: r.ms ? nowMs - r.ms : null, until: null })
  }

  const applyCustom = (from, to) => {
    setCustomFrom(from)
    setCustomTo(to)
    setRange(customRange(from, to))
  }

  const clearAll = () => {
    setGroups([])
    setDevices([])
    setTags([])
    setRange({ id: 'all', since: null, until: null })
    setCustomFrom('')
    setCustomTo('')
  }

  // A refresh re-anchors a relative window to NOW. Without it, "24 hours"
  // chosen at nine in the morning would still mean "since yesterday 09:00"
  // at six in the evening.
  const refresh = () => {
    if (range.id !== 'all' && range.id !== 'custom') pickRange(range.id)
    setRefreshes((n) => n + 1)
  }

  const filters = {
    devices, kinds, tags,
    since: range.since, until: range.until,
  }
  // Any change of filter REMOUNTS the results. That resets the list and the
  // cursor in one move, and cancels an in-flight request for the old
  // filters so a slow response cannot land on top of the new ones.
  const key = JSON.stringify([filters, refreshes])

  return (
    <div className="alog">
      <div className="alog-filters">
        <FilterRow label="When">
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.id} type="button"
                      className={range.id === r.id ? 'is-on' : ''}
                      aria-pressed={range.id === r.id}
                      onClick={() => pickRange(r.id)}>
                {r.label}
              </button>
            ))}
          </div>
          {range.id === 'custom' && (
            <div className="alog-dates">
              <input type="date" value={customFrom} aria-label="From"
                     onChange={(e) => applyCustom(e.target.value, customTo)} />
              <span>to</span>
              <input type="date" value={customTo} aria-label="To"
                     onChange={(e) => applyCustom(customFrom, e.target.value)} />
            </div>
          )}
        </FilterRow>

        <FilterRow label="Type">
          <div className="chips">
            {KIND_GROUPS.map((g) => (
              <Chip key={g.id} on={groups.includes(g.id)} tone={g.tone}
                    onClick={() => setGroups(toggle(groups, g.id))}>
                {g.label}
              </Chip>
            ))}
          </div>
        </FilterRow>

        {isCompany && tenants.length > 0 && (
          <FilterRow label="Tenant">
            <TenantPicker tenants={tenants} selected={devices} onChange={setDevices} />
          </FilterRow>
        )}

        {readings.length > 0 && (
          <FilterRow label="Reading">
            <div className="chips">
              {readings.map((r) => (
                <Chip key={r} on={tags.includes(r)} onClick={() => setTags(toggle(tags, r))}>
                  {r}
                </Chip>
              ))}
            </div>
          </FilterRow>
        )}

        <div className="alog-filter-foot">
          <button type="button" className="alog-link" onClick={refresh}>↻ Refresh</button>
          {active > 0 && (
            <button type="button" className="alog-link" onClick={clearAll}>
              Clear {active} filter{active === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>

      <AlertResults
        key={key}
        scope={scope}
        filters={filters}
        names={names}
        showTenant={isCompany}
        nowMs={nowMs}
        onOpenDevice={onOpenDevice}
        filtered={active > 0}
      />
    </div>
  )
}

/**
 * One filtered result set, from its first page onward.
 *
 * Mounted fresh for every filter combination (see the key above), so its
 * first fetch runs from the mount effect and settles state in the promise
 * callback. That keeps state out of the effect's synchronous body, and the
 * `cancelled` flag means an abandoned request can never write into a list
 * that now belongs to different filters.
 */
function AlertResults({ scope, filters, names, showTenant, nowMs, onOpenDevice, filtered }) {
  const [state, setState] = useState({
    alerts: [], cursor: null, hasMore: false, partial: false,
    searchedTo: null, loading: true, error: null,
  })

  const fetchPage = (cursor) => {
    const opts = { ...filters, cursor }
    return scope.company
      ? fetchCompanyAlerts(scope.company, opts)
      : fetchAlerts(scope.device, opts)
  }

  useEffect(() => {
    let cancelled = false
    fetchPage(null).then(
      (page) => { if (!cancelled) setState({ ...page, loading: false, error: null }) },
      (e) => { if (!cancelled) setState((s) => ({ ...s, loading: false, error: e.message || String(e) })) },
    )
    return () => { cancelled = true }
    // Mounted once per filter set by design - the parent's key does the
    // re-running, so the dependencies here are intentionally empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadMore = async () => {
    setState((s) => ({ ...s, loading: true }))
    try {
      const page = await fetchPage(state.cursor)
      setState((s) => ({
        ...page,
        alerts: [...s.alerts, ...page.alerts],
        loading: false,
        error: null,
      }))
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e.message || String(e) }))
    }
  }

  const days = groupByDay(state.alerts, nowMs)

  return (
    <div className="alog-results">
      <div className="alog-summary" aria-live="polite">
        {state.loading && state.alerts.length === 0
          ? 'Loading…'
          : `${state.alerts.length}${state.hasMore ? '+' : ''} alert${state.alerts.length === 1 ? '' : 's'}`}
        {state.partial && state.searchedTo != null && (
          // Honest about a short page: the budget ran out before it filled.
          <span className="alog-partial">
            {' '}· searched back to {fmtDate(state.searchedTo)}
          </span>
        )}
      </div>

      {state.error && (
        <div className="notice notice-warn"><p>Could not load alerts: {state.error}</p></div>
      )}

      {!state.loading && !state.error && state.alerts.length === 0 && (
        <p className="alog-empty">
          {filtered
            ? 'Nothing matches these filters. Widen the time range or clear a filter.'
            : 'No alerts recorded yet. That is the expected state for a healthy site - nothing crossed an alert threshold and nothing stopped reporting.'}
        </p>
      )}

      {days.map((day) => (
        <section key={day.key} className="alog-day">
          <h3 className="alog-day-head">{day.label}</h3>
          <ul className="alog-list">
            {day.alerts.map((a) => (
              <li key={`${a.device}_${a.id}`}
                  className={`alog-row level-${a.level || 'info'}${showTenant ? '' : ' no-tenant'}`}>
                <time className="alog-time" dateTime={new Date(a.ts).toISOString()}>
                  {fmtTime(a.ts)}
                </time>
                <span className={`alog-dot tone-${a.level || 'info'}`} aria-hidden="true" />
                {showTenant && (
                  <button type="button" className="alog-tenant"
                          onClick={() => onOpenDevice?.(a.device)}
                          title={`Open ${names[a.device] || a.device}`}>
                    {names[a.device] || a.device}
                  </button>
                )}
                <span className={`alog-kind kind-${a.kind}`}>{KIND_LABEL[a.kind] || a.kind}</span>
                <span className="alog-msg">{a.message}</span>
                {typeof a.value === 'number' && (
                  <span className="alog-val">
                    {fmtValue(a.value)}
                    {typeof a.limit === 'number' && <span className="alog-lim"> / {a.limit}</span>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {state.hasMore && !state.error && (
        <button type="button" className="alog-more" onClick={loadMore} disabled={state.loading}>
          {state.loading ? 'Loading…' : state.partial ? 'Keep searching older' : 'Load older'}
        </button>
      )}
    </div>
  )
}

function FilterRow({ label, children }) {
  return (
    <div className="alog-row-f">
      <span className="alog-label">{label}</span>
      <div className="alog-ctrl">{children}</div>
    </div>
  )
}

function Chip({ on, tone, onClick, children }) {
  return (
    <button type="button" className={`chip ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={onClick}>
      {tone && <span className={`chip-dot tone-${tone}`} aria-hidden="true" />}
      {children}
    </button>
  )
}

/**
 * Pick tenants from a list that can be ninety long - so it searches, and
 * shows a count on the closed button rather than trying to list names in it.
 */
function TenantPicker({ tenants, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const box = useRef(null)

  // Close on a click anywhere else. State is only set inside the listener,
  // never in the effect body itself.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const q = query.trim().toLowerCase()
  const list = [...tenants]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((t) => !q || t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))

  const summary = selected.length === 0
    ? 'All tenants'
    : selected.length === 1
      ? (tenants.find((t) => t.id === selected[0])?.name || selected[0])
      : `${selected.length} tenants`

  return (
    <div className="tpick" ref={box}>
      <button type="button" className={`tpick-btn ${selected.length ? 'is-on' : ''}`}
              aria-haspopup="listbox" aria-expanded={open}
              onClick={() => setOpen((v) => !v)}>
        {summary}
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="tpick-pop" role="listbox" aria-multiselectable="true">
          <input className="tpick-search" type="search" placeholder="Search tenants"
                 value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
          <div className="tpick-actions">
            <button type="button" onClick={() => onChange(list.map((t) => t.id))}>Select shown</button>
            <button type="button" onClick={() => onChange([])}>Clear</button>
          </div>
          <ul className="tpick-list">
            {list.map((t) => {
              const on = selected.includes(t.id)
              return (
                <li key={t.id}>
                  <label className={on ? 'is-on' : ''}>
                    <input type="checkbox" checked={on}
                           onChange={() => onChange(toggle(selected, t.id))} />
                    <span>{t.name}</span>
                    {t.name !== t.id && <span className="tpick-id">{t.id}</span>}
                  </label>
                </li>
              )
            })}
            {list.length === 0 && <li className="tpick-none">No tenant matches “{query}”</li>}
          </ul>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function toggle(list, v) {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

/** A custom range from two yyyy-mm-dd strings, whole local days, `to` inclusive. */
function customRange(from, to) {
  const since = from ? new Date(`${from}T00:00:00`).getTime() : null
  const end = to ? new Date(`${to}T00:00:00`).getTime() + 86400000 : null
  return {
    id: 'custom',
    since: Number.isFinite(since) ? since : null,
    until: Number.isFinite(end) ? end : null,
  }
}

/**
 * Alerts grouped under a heading per local day, newest first. A long log
 * read as one undifferentiated list loses the thing people scan it for:
 * "what happened on Tuesday".
 */
function groupByDay(alerts, nowMs) {
  const out = []
  const today = dayKey(nowMs)
  const yesterday = dayKey(nowMs - 86400000)
  for (const a of alerts) {
    const k = dayKey(a.ts)
    let g = out[out.length - 1]
    if (!g || g.key !== k) {
      g = {
        key: k,
        label: k === today ? 'Today' : k === yesterday ? 'Yesterday' : fmtDate(a.ts),
        alerts: [],
      }
      out.push(g)
    }
    g.alerts.push(a)
  }
  return out
}

function dayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function fmtValue(v) {
  const a = Math.abs(v)
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2)
}
