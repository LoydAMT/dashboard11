import { useAuth } from '../hooks/useAuth'
import { useIsAdmin } from '../hooks/useIsAdmin'
import { useRtdbValue } from '../hooks/useRtdbValue'
import { useDeviceName } from '../hooks/useDeviceName'
import { useTheme } from '../hooks/useTheme'
import { useNow } from '../hooks/useNow'
import { formatAgo } from '../lib/time'
import { signOutUser } from '../auth'
import { Masthead } from './Masthead'
import { SignIn } from './SignIn'

/**
 * /performance - how every box has done over the last hour, for admins.
 *
 * The numbers are worked out once an hour on the server (functions/
 * boxHealth.js, at the end of archiveSweep) and this page only reads that
 * one small node, so leaving it open costs next to nothing. It updates by
 * itself when the next hour's figures are written.
 *
 * Admins only, twice over: the rules refuse boxHealth/ to anyone else, and
 * this page shows nothing to a signed-in account that is not one.
 */
export function PerformancePage() {
  const { user, resolved, realUser } = useAuth()
  const isAdmin = useIsAdmin(realUser ? user : null)
  const { theme, setTheme } = useTheme()
  const health = useRtdbValue('boxHealth', Boolean(realUser && isAdmin))
  const now = useNow(30000)

  if (!resolved) {
    return <div className="app"><div className="notice notice-info"><h2>Loading…</h2><p>Checking your session.</p></div></div>
  }
  if (!realUser) return <SignIn />

  const masthead = (
    <Masthead
      tagline="Performance"
      signedIn
      email={user?.email}
      onSignOut={signOutUser}
      theme={theme}
      onThemeChange={setTheme}
      link={{ href: '/', label: '← Dashboard' }}
    />
  )

  if (!isAdmin) {
    return (
      <div className="app">
        {masthead}
        <div className="notice notice-info">
          <h2>Not available</h2>
          <p>This page is not available for this account.</p>
        </div>
      </div>
    )
  }

  const current = health.data?.current || {}
  const hours = health.data?.hours || {}
  const boxes = Object.entries(current).sort(([a, x], [b, y]) =>
    RANK[x.status] - RANK[y.status] || String(x.name).localeCompare(String(y.name)) || a.localeCompare(b))
  const newest = Math.max(0, ...boxes.map(([, s]) => s.at || 0))

  return (
    <div className="app perf-page">
      {masthead}
      <div className="admin-intro">
        <h2>Box performance</h2>
        <p className="admin-hint">
          The last hour for every box, worked out on the server once an hour (a few minutes past).
          {newest > 0 && ` Last updated ${formatAgo(now - newest)}.`}
        </p>
      </div>

      {health.error && (
        <p className="naming-row-error" role="alert">Could not read box health: {health.error.message || String(health.error)}</p>
      )}
      {health.loading && <p className="admin-hint">Loading…</p>}
      {!health.loading && !health.error && boxes.length === 0 && (
        <p className="admin-hint">No figures yet. The first appear a few minutes past the next hour.</p>
      )}

      <div className="perf-list">
        {boxes.map(([id, s]) => <BoxCard key={id} id={id} s={s} hours={hours[id] || {}} />)}
      </div>
    </div>
  )
}

const RANK = { problem: 0, watch: 1, good: 2 }
const LABEL = { good: 'Good', watch: 'Watch', problem: 'Problem' }

function BoxCard({ id, s, hours }) {
  const status = s.status || 'problem'
  const lost = (s.missingMinutes || 0) + (s.lateMinutes || 0)
  return (
    <section className={`perf-box is-${status}`}>
      <div className="perf-head">
        <span className="perf-name">{s.name || id}</span>
        {s.name && s.name !== id && <span className="perf-id">{id}</span>}
        <span className={`perf-chip is-${status}`}>{LABEL[status] || status}</span>
      </div>

      <dl className="perf-stats">
        <Stat label="Last heard from" value={s.heartbeatAgeS == null ? 'never' : `${ageText(s.heartbeatAgeS)} ago`} />
        <Stat label="Meters reading" value={`${s.reading} of ${s.meters}`} />
        <Stat label="Readings per minute" value={s.perMinute ? `${s.perMinute}${s.fullPct != null ? ` · ${s.fullPct}% full` : ''}` : '—'} />
        <Stat
          label="Minutes not on time (of 60)"
          value={s.missingMinutes == null ? 'not tracked, sends on change'
            : lost === 0 ? 'none' : `${lost}${s.lateMinutes ? ` (${s.lateMinutes} sent late)` : ''}`}
        />
        <Stat label="Meter total read" value={s.kwhAgeS == null ? '—' : `${ageText(s.kwhAgeS)} ago`} />
        <Stat label="Last 10 PM reading" value={s.lastDaily ? dayTime(s.lastDaily) : '—'} />
      </dl>

      {s.silent?.length > 0 && (
        <p className="perf-silent">
          Not answering: {s.silent.map((d, i) => <span key={d}>{i > 0 && ', '}<MeterName id={d} /></span>)}
        </p>
      )}

      <Strip hours={hours} />
    </section>
  )
}

/** The last 24 hours, oldest on the left, one cell per hour. */
function Strip({ hours }) {
  const keys = Object.keys(hours).map(Number).sort((a, b) => a - b).slice(-24)
  if (keys.length === 0) return null
  return (
    <div>
      <div className="perf-strip" role="img" aria-label="Hourly status, last 24 hours">
        {keys.map((k) => {
          const h = hours[k]
          const lost = (h.missing || 0) + (h.late || 0)
          return (
            <span
              key={k}
              className={`perf-cell is-${h.status}`}
              title={`${dayTime(k)}: ${lost} minute${lost === 1 ? '' : 's'} not on time, ${h.reading} meters reading`}
            />
          )
        })}
      </div>
      <div className="perf-strip-label"><span>{dayTime(keys[0])}</span><span>now</span></div>
    </div>
  )
}

function Stat({ label, value }) {
  return <div className="perf-stat"><dt>{label}</dt><dd>{value}</dd></div>
}

// A component per meter, for its own name lookup.
function MeterName({ id }) {
  const { name } = useDeviceName(id)
  return name
}

function ageText(s) {
  if (s < 90) return `${s} s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 3600)} h`
}

function dayTime(ms) {
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
