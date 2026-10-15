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
        <Legend />
      </div>

      {health.error && (
        <p className="naming-row-error" role="alert">Could not read box health: {health.error.message || String(health.error)}</p>
      )}
      {health.loading && <p className="admin-hint">Loading…</p>}
      {!health.loading && !health.error && boxes.length === 0 && (
        <p className="admin-hint">No figures yet. The first appear a few minutes past the next hour.</p>
      )}

      <div className="perf-list">
        {boxes.map(([id, s]) => <BoxCard key={id} id={id} s={s} hours={hours[id] || {}} now={now} />)}
      </div>
    </div>
  )
}

const RANK = { problem: 0, watch: 1, good: 2 }

/** What each label means, once, above the boxes. */
function Legend() {
  return (
    <details className="perf-legend">
      <summary>What Good, Watch and Problem mean</summary>
      <dl>
        <dt><span className="perf-chip is-good">Good</span></dt>
        <dd>Connected, and every minute of the last hour arrived on time with its usual number of readings.</dd>
        <dt><span className="perf-chip is-watch">Watch</span></dt>
        <dd>
          Working, but not cleanly: 5 or more of the last 60 minutes did not arrive on time, or under 90% of
          minutes held their usual number of readings. Nothing is lost - a box that cannot upload keeps the
          readings and sends them later as 10-minute rows - but the charts are coarser there. Usually the
          site&apos;s internet dropping out for a moment.
        </dd>
        <dt><span className="perf-chip is-problem">Problem</span></dt>
        <dd>
          Needs someone to look now: the box has not been heard from for over 3 minutes, no meter on it is
          sending readings, or the 10 PM meter reading - the one bills are made from - has not arrived in
          the last 26 hours.
        </dd>
      </dl>
      <p>
        Meters that are not answering are listed on each box but do not change its label: a meter switched
        off at the site is not a fault in the box.
      </p>
    </details>
  )
}

/**
 * Why a box has the label it has, in words - worked out from the same
 * figures and the same limits the server used (functions/boxHealth.js:
 * verdict), so the explanation and the label cannot disagree.
 */
function reasons(s, now) {
  const out = []
  const lost = (s.missingMinutes || 0) + (s.lateMinutes || 0)
  const dailyLate = s.lastDaily != null && now - s.lastDaily > 26 * 3600e3

  if (s.heartbeatAgeS == null) out.push('This box has never reported in.')
  else if (s.heartbeatAgeS > 180) out.push(`Not heard from for ${ageText(s.heartbeatAgeS)} - it may be off, or offline.`)
  if (s.reading === 0) out.push('No meter on this box sent a reading in the last hour.')
  if (dailyLate) out.push(`No 10 PM meter reading since ${dayTime(s.lastDaily)} - check before the next bill is made.`)
  if (out.length) return out

  if (lost >= 5) {
    const parts = []
    if (s.missingMinutes) parts.push(`${s.missingMinutes} did not arrive`)
    if (s.lateMinutes) parts.push(`${s.lateMinutes} were sent late as 10-minute rows`)
    out.push(
      `${lost} of the last 60 minutes were not on time (${parts.join(', ')}). 5 or more is flagged. `
      + 'The box kept those readings and sends them once it can; this usually means its internet connection dropped out briefly.',
    )
  }
  if (s.fullPct != null && s.fullPct < 90) {
    out.push(
      `Only ${s.fullPct}% of minutes held the usual ${s.perMinute} readings, so the box is reading its meters `
      + 'more slowly than normal - often a meter not answering, or a slow line.',
    )
  }
  if (out.length) return out

  if (s.missingMinutes == null) {
    out.push('Connected and sending. This box only sends a reading when it changes, so quiet minutes are normal and are not counted.')
  } else {
    out.push(`Connected, and all 60 minutes of the last hour arrived on time with ${s.perMinute} readings each.`)
  }
  if (s.missingMinutes != null && lost > 0) {
    out.push(`${lost} minute${lost === 1 ? ' was' : 's were'} not on time - under the 5 that would flag it.`)
  }
  return out
}
const LABEL = { good: 'Good', watch: 'Watch', problem: 'Problem' }

function BoxCard({ id, s, hours, now }) {
  const status = s.status || 'problem'
  const lost = (s.missingMinutes || 0) + (s.lateMinutes || 0)
  return (
    <section className={`perf-box is-${status}`}>
      <div className="perf-head">
        <span className="perf-name">{s.name || id}</span>
        {s.name && s.name !== id && <span className="perf-id">{id}</span>}
        <span className={`perf-chip is-${status}`}>{LABEL[status] || status}</span>
      </div>

      <ul className={`perf-why is-${status}`}>
        {reasons(s, now).map((r) => <li key={r}>{r}</li>)}
      </ul>

      <dl className="perf-stats">
        <Stat label="Last heard from" value={s.heartbeatAgeS == null ? 'never' : `${ageText(s.heartbeatAgeS)} ago`} />
        <Stat label="Meters reading" value={`${s.reading} of ${s.meters}`} />
        <Stat label="Readings per minute" value={s.perMinute ? `${s.perMinute}${s.fullPct != null ? ` · ${s.fullPct}% full` : ''}` : '—'} />
        <Stat
          label="Minutes not on time (of 60)"
          value={s.missingMinutes == null ? 'not tracked, sends on change'
            : lost === 0 ? 'none' : `${lost}${s.lateMinutes ? ` (${s.lateMinutes} sent late)` : ''}`}
        />
        {s.kwhAgeS != null && <Stat label="Meter total read" value={`${ageText(s.kwhAgeS)} ago`} />}
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
