import { formatAgo, formatLocal } from '../lib/time'

// One line of plain language per state. An operator should not have to decode a
// colour to know whether the screen can be trusted.
const TITLES = {
  live: 'Live',
  stale: 'Not updating',
  disconnected: 'Disconnected',
  'no-data': 'No data',
  connecting: 'Connecting',
}

export function StatusBanner({ state, status }) {
  const { level, ageMs, detail } = state
  const title = TITLES[level] || level

  return (
    <div className={`banner banner-${level}`} role="status" aria-live="polite">
      <span className="banner-dot" aria-hidden="true" />
      <div className="banner-text">
        <div className="banner-title">
          {title}
          {level === 'live' && ageMs != null && ` · updated ${formatAgo(ageMs)}`}
          {level === 'stale' && ageMs != null && ` · last data ${formatAgo(ageMs)}`}
        </div>
        <div className="banner-detail">
          {detail}
          {level === 'stale' && status?.lastSeen != null && (
            <> Last reading was at {formatLocal(status.lastSeen)}.</>
          )}
          {level === 'disconnected' && (
            <> The last values below are from before the connection dropped.</>
          )}
        </div>
      </div>
    </div>
  )
}
