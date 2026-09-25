import { useState } from 'react'
import { useMallOverview, rankTenants } from '../hooks/useMallOverview'
import { useCompany } from '../hooks/useCompanies'
import { formatAgo } from '../lib/time'

/**
 * Every tenant in one company, on one page.
 *
 * This is the landlord's page, not a tenant's. It answers three questions
 * and deliberately stops there: which units need attention, what is each
 * one drawing now, and what did each one consume yesterday. Anything about
 * a single unit over time belongs on that unit's own dashboard, which is
 * one click away.
 *
 * Ordering defaults to attention rather than to name. An alphabetical list
 * of ninety shops buries the one that is offline, which is the only row
 * that matters on the day it happens.
 *
 * `nowMs` is a PROP rather than a Date.now() call in the body. Reading the
 * clock while rendering is impure - the ages it produces would not update
 * on their own, so a row could sit reading "offline 2m ago" for an hour.
 * The app already ticks one clock for the whole page; this shares it.
 */
export function MallOverview({ companyId, companyName, onOpenDevice, onClose, nowMs }) {
  const [sortKey, setSortKey] = useState('attention')
  const { loading, error, tenants, totals, updatedAt } = useMallOverview(companyId)

  if (error) {
    return (
      <div className="notice notice-warn">
        <h2>Overview unavailable</h2>
        <p>
          Could not read the overview for this company: {error.message || String(error)}
        </p>
        {onClose && <button type="button" onClick={onClose}>Back</button>}
      </div>
    )
  }

  const rows = rankTenants(tenants, sortKey)
  const needsAttention = (totals?.inAlarm || 0) + (totals?.offline || 0)

  return (
    <div className="mall">
      <div className="mall-head">
        <div>
          <h2>{companyName || 'All tenants'}</h2>
          <p className="mall-sub">
            {totals ? `${totals.tenants} tenant${totals.tenants === 1 ? '' : 's'}` : '—'}
            {updatedAt != null && ` · updated ${formatAgo(nowMs - updatedAt)}`}
          </p>
        </div>
        {onClose && (
          <button type="button" className="mall-close" onClick={onClose}>Back</button>
        )}
      </div>

      <div className="mall-totals">
        <div className={`mall-stat ${needsAttention > 0 ? 'is-bad' : 'is-good'}`}>
          <span className="mall-stat-n">{needsAttention}</span>
          <span className="mall-stat-l">need attention</span>
        </div>
        <div className="mall-stat">
          <span className="mall-stat-n">{totals?.offline ?? '—'}</span>
          <span className="mall-stat-l">offline</span>
        </div>
        <div className="mall-stat">
          <span className="mall-stat-n">
            {totals?.kwhToday != null ? totals.kwhToday.toFixed(1) : '—'}
          </span>
          {/* Says what the total covers. A mall figure spanning 40 of 90
              units is misleading unless it admits it. */}
          <span className="mall-stat-l">
            kWh {totals?.kwhDate || ''}
            {totals?.kwhFrom != null && totals?.tenants != null
              && totals.kwhFrom < totals.tenants
              ? ` · ${totals.kwhFrom} of ${totals.tenants} units`
              : ''}
          </span>
        </div>
      </div>

      <div className="mall-sorts">
        {[['attention', 'Needs attention'], ['kwh', 'Consumption'], ['name', 'Name']]
          .map(([k, lbl]) => (
            <button
              key={k}
              type="button"
              className={sortKey === k ? 'is-active' : ''}
              onClick={() => setSortKey(k)}
            >
              {lbl}
            </button>
          ))}
      </div>

      {loading && rows.length === 0 && <p className="mall-empty">Loading…</p>}

      {!loading && rows.length === 0 && (
        <p className="mall-empty">
          No tenants are reporting into this company yet. The overview is built
          by the server every two minutes, so a newly added tenant appears on
          the next sweep rather than immediately.
        </p>
      )}

      <ul className="mall-list">
        {rows.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className={`mall-row alarm-${t.alarm}`}
              onClick={() => onOpenDevice?.(t.id)}
            >
              <span className={`mall-dot dot-${t.alarm}`} aria-hidden="true" />
              <span className="mall-name">{t.name}</span>

              <span className="mall-values">
                {Object.entries(t.values).slice(0, 3).map(([k, v]) => (
                  <span key={k} className="mall-val">
                    <b>{typeof v === 'number' ? v.toFixed(2) : v}</b> {k}
                  </span>
                ))}
                {Object.keys(t.values).length === 0 && (
                  <span className="mall-val mall-val-none">no reading</span>
                )}
              </span>

              <span className="mall-kwh">
                {t.kwh?.deltaKwh != null
                  ? <><b>{t.kwh.deltaKwh.toFixed(1)}</b> kWh</>
                  : <span className="mall-val-none">—</span>}
                {/* A reset makes the day's delta meaningless, so it is
                    flagged rather than quietly billed. */}
                {t.kwh?.resetSuspected && <em className="mall-warn"> meter reset</em>}
              </span>

              <span className="mall-state">
                {t.alarm === 'offline'
                  ? (t.lastSeen ? `offline ${formatAgo(nowMs - t.lastSeen)}` : 'never reported')
                  : t.alarm === 'high' ? 'above threshold'
                  : t.alarm === 'low' ? 'below threshold'
                  : 'ok'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Entry point to a company's overview, rendered once per company the user
 * belongs to.
 *
 * A COMPONENT rather than a loop over useCompany, because hooks cannot be
 * called in a loop whose length changes at runtime - joining a company would
 * change the hook count between renders and crash. This is the same reason
 * DevicePicker renders a row component per device.
 *
 * Renders nothing for a single-device company: holding one device IS a
 * tenant, and a "view all tenants" link to a list of one is noise.
 */
export function MallEntry({ companyId, onOpen }) {
  const { name, deviceIds, loading } = useCompany(companyId)
  if (loading || deviceIds.length < 2) return null
  return (
    <button type="button" className="mall-entry" onClick={() => onOpen(companyId, name)}>
      <span className="mall-entry-name">{name}</span>
      <span className="mall-entry-count">{deviceIds.length} tenants →</span>
    </button>
  )
}
