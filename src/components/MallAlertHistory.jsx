import { useCallback, useEffect, useState } from 'react'
import { fetchCompanyAlerts, alertsConfigured } from '../lib/alertsApi'

/**
 * Every alert across every tenant of one company, newest first.
 *
 * WHY THIS IS NOT THE STRIP ON THE MALL PAGE
 * That strip shows each tenant's MOST RECENT transition and nothing else -
 * bounded by tenant count, assembled from the overview node for free, and
 * the right thing for "what is happening now". This is the record: the
 * complete log, written by the sweep whether or not anyone was signed in,
 * paged back as far as it goes.
 *
 * One indexed collection-group query serves it however many tenants there
 * are, so opening this on a mall of ninety costs what it costs on a mall of
 * three.
 */
export function MallAlertHistory({ companyId, companyName, onClose, onOpenDevice }) {
  const [alerts, setAlerts] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [kindFilter, setKindFilter] = useState('all')

  const load = useCallback(async (before = null) => {
    setLoading(true)
    setError(null)
    try {
      const page = await fetchCompanyAlerts(companyId, { before })
      setAlerts((prev) => (before == null ? page.alerts : [...prev, ...page.alerts]))
      setHasMore(page.hasMore)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => {
    setAlerts([])
    setHasMore(false)
    load(null)
  }, [companyId, load])

  if (!alertsConfigured()) {
    return (
      <div className="notice notice-warn">
        <h2>Alert history unavailable</h2>
        <p>
          VITE_ALERTS_API_URL is not set for this build, so the server-side
          log cannot be read. Live alerts still work; only the history is
          missing.
        </p>
        {onClose && <button type="button" onClick={onClose}>Back</button>}
      </div>
    )
  }

  const shown = kindFilter === 'all' ? alerts : alerts.filter((a) => a.kind === kindFilter)
  // Built from what actually arrived rather than a fixed list, so a new
  // alert kind added server-side appears here without a UI change.
  const kinds = [...new Set(alerts.map((a) => a.kind))].sort()

  return (
    <div className="alert-history">
      <div className="alert-history-head">
        <h2>All alerts · {companyName || 'this company'}</h2>
        {onClose && (
          <button type="button" className="alert-history-close" onClick={onClose}>Back</button>
        )}
      </div>

      <p className="alert-history-note">
        Every tenant in this company, newest first. Recorded on the server, so
        events that happened while nobody was signed in are here too. Kept for
        the life of the deployment.
      </p>

      {kinds.length > 0 && (
        <div className="alert-history-filters">
          <button type="button"
                  className={kindFilter === 'all' ? 'is-active' : ''}
                  onClick={() => setKindFilter('all')}>
            All ({alerts.length})
          </button>
          {kinds.map((k) => (
            <button key={k} type="button"
                    className={kindFilter === k ? 'is-active' : ''}
                    onClick={() => setKindFilter(k)}>
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
          No alerts recorded for this company yet. That is the expected state
          for a healthy site - an empty log means nothing crossed an alert
          threshold and no tenant stopped reporting.
        </p>
      )}

      <ul className="alert-history-list">
        {shown.map((a) => (
          <li key={`${a.device}_${a.id}`} className={`alert-history-item level-${a.level || 'info'}`}>
            <time dateTime={new Date(a.ts).toISOString()}>
              {new Date(a.ts).toLocaleString()}
            </time>
            {/* Which tenant, because on a mall-wide log that is the first
                thing anyone needs and the per-device view never had to say. */}
            <button
              type="button"
              className="alert-history-device"
              onClick={() => onOpenDevice?.(a.device)}
              title={`Open ${a.device}`}
            >
              {a.device}
            </button>
            <span className="alert-history-kind">{a.kind}</span>
            <span className="alert-history-message">{a.message}</span>
            {typeof a.value === 'number' && (
              <span className="alert-history-value">
                {a.value}
                {typeof a.limit === 'number' ? ` (threshold ${a.limit})` : ''}
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
