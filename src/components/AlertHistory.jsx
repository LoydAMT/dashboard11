import { useCallback, useEffect, useState } from 'react'
import { fetchAlerts, alertsConfigured } from '../lib/alertsApi'

/**
 * The full alert record for a device, from the server.
 *
 * The bell (AlertBell) shows what this browser happened to witness while it
 * was open. This shows what actually happened - including everything that
 * occurred overnight with nobody signed in, which the bell can never know
 * about. They are deliberately separate: one is a live notifier, this is
 * the log you go back to.
 *
 * Paged with a cursor rather than "load everything", because this history
 * is unbounded by design - it is kept for the life of the deployment.
 */
export function AlertHistory({ deviceId, onClose }) {
  const [alerts, setAlerts] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [kindFilter, setKindFilter] = useState('all')

  const load = useCallback(async (before = null) => {
    setLoading(true)
    setError(null)
    try {
      const page = await fetchAlerts(deviceId, { before })
      setAlerts((prev) => (before == null ? page.alerts : [...prev, ...page.alerts]))
      setHasMore(page.hasMore)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [deviceId])

  useEffect(() => {
    setAlerts([])
    setHasMore(false)
    load(null)
  }, [deviceId, load])

  if (!alertsConfigured()) {
    return (
      <div className="notice notice-warn">
        <h2>Alert history unavailable</h2>
        <p>
          VITE_ALERTS_API_URL is not set for this build, so the server-side log
          cannot be read. Live alerts still work; only the history is missing.
        </p>
        {onClose && <button type="button" onClick={onClose}>Back</button>}
      </div>
    )
  }

  const shown = kindFilter === 'all'
    ? alerts
    : alerts.filter((a) => a.kind === kindFilter)

  // Built from what actually arrived rather than a fixed list, so a new
  // alert kind added server-side appears here without a UI change.
  const kinds = [...new Set(alerts.map((a) => a.kind))].sort()

  return (
    <div className="alert-history">
      <div className="alert-history-head">
        <h2>Alert history</h2>
        {onClose && (
          <button type="button" className="alert-history-close" onClick={onClose}>
            Back
          </button>
        )}
      </div>

      <p className="alert-history-note">
        Recorded on the server, so events that happened while nobody was signed
        in are here too. Kept for the life of the deployment.
      </p>

      {kinds.length > 0 && (
        <div className="alert-history-filters">
          <button
            type="button"
            className={kindFilter === 'all' ? 'is-active' : ''}
            onClick={() => setKindFilter('all')}
          >
            All ({alerts.length})
          </button>
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className={kindFilter === k ? 'is-active' : ''}
              onClick={() => setKindFilter(k)}
            >
              {k} ({alerts.filter((a) => a.kind === k).length})
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="notice notice-warn">
          <p>Could not load the alert history: {error}</p>
        </div>
      )}

      {!loading && !error && shown.length === 0 && (
        <p className="alert-history-empty">
          No alerts recorded for this device yet. That is the expected state for
          a healthy box - an empty log here means nothing crossed a limit and
          the device never stopped reporting.
        </p>
      )}

      <ul className="alert-history-list">
        {shown.map((a) => (
          <li key={a.id} className={`alert-history-item level-${a.level || 'info'}`}>
            <time dateTime={new Date(a.ts).toISOString()}>
              {new Date(a.ts).toLocaleString()}
            </time>
            <span className="alert-history-kind">{a.kind}</span>
            <span className="alert-history-message">{a.message}</span>
            {typeof a.value === 'number' && (
              <span className="alert-history-value">
                {a.value}
                {typeof a.limit === 'number' ? ` (limit ${a.limit})` : ''}
              </span>
            )}
          </li>
        ))}
      </ul>

      {loading && <p className="alert-history-empty">Loading…</p>}

      {hasMore && !loading && alerts.length > 0 && (
        <button
          type="button"
          className="alert-history-more"
          onClick={() => load(alerts[alerts.length - 1].ts)}
        >
          Load older
        </button>
      )}
    </div>
  )
}
