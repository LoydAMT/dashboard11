import { useState } from 'react'
import { useMallOverview, rankTenants, primaryTag, meterTag, recentAlerts } from '../hooks/useMallOverview'
import { useCompany } from '../hooks/useCompanies'
import { gaugeScale } from '../lib/gauge'
import { TagGauge } from './TagGauge'
import { formatAgo } from '../lib/time'

/**
 * Every tenant in a mall, on ONE page, each with its own dial.
 *
 * This is the whole product for a landlord: walk up to the screen and see
 * all of it at once. Opening a single tenant is still possible, but it is
 * the exception - not the way the page is meant to be read.
 *
 * ONE SUBSCRIPTION DRAWS ALL OF THEM. Every dial's thresholds and its scale
 * arrive inside mallOverview/{companyId}, written by the sweep that already
 * walks each device. Reading alertRules per tenant from here would be the
 * ninety-listener fan-out the projection exists to avoid.
 *
 * Ordering defaults to attention rather than to name: an alphabetical wall
 * of ninety shops buries the one that is offline, which is the only tile
 * that matters on the day it happens.
 */
export function MallOverview({ companyId, companyName, onOpenDevice, onClose, nowMs }) {
  const [sortKey, setSortKey] = useState('attention')
  const { loading, error, tenants, totals, updatedAt } = useMallOverview(companyId)

  if (error) {
    return (
      <div className="notice notice-warn">
        <h2>Overview unavailable</h2>
        <p>Could not read this company&apos;s overview: {error.message || String(error)}</p>
        {onClose && <button type="button" onClick={onClose}>Back</button>}
      </div>
    )
  }

  const rows = rankTenants(tenants, sortKey)
  const recent = recentAlerts(tenants)
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
        {onClose && <button type="button" className="mall-close" onClick={onClose}>Back</button>}
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
            <button key={k} type="button"
                    className={sortKey === k ? 'is-active' : ''}
                    onClick={() => setSortKey(k)}>
              {lbl}
            </button>
          ))}
      </div>

      {/* What happened, next to what is wrong now. Built from one field per
          tenant, so the whole mall's feed costs no extra read. */}
      {recent.length > 0 && (
        <div className="mall-recent">
          <h3>Recent alerts</h3>
          <ul>
            {recent.map((t) => (
              <li key={t.id} className={`level-${t.lastAlert.level}`}>
                <span className="mall-recent-when">
                  {formatAgo(nowMs - t.lastAlert.ts)}
                </span>
                <span className="mall-recent-who">{t.name}</span>
                <span className="mall-recent-what">{t.lastAlert.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading && rows.length === 0 && <p className="mall-empty">Loading…</p>}

      {!loading && rows.length === 0 && (
        <p className="mall-empty">
          No tenants are reporting into this company yet. The overview is built
          by the server every two minutes, so a newly added tenant appears on
          the next sweep rather than immediately.
        </p>
      )}

      <div className="mall-grid">
        {rows.map((t) => (
          <TenantTile key={t.id} tenant={t} nowMs={nowMs} onOpen={onOpenDevice} />
        ))}
      </div>
    </div>
  )
}

/**
 * One tenant: a dial, its reading, the day's meter figure, and the name.
 *
 * The dial is the SAME component the single-device dashboard uses, fed the
 * same way - a configured threshold lands on 10% and 90%, an unruled tag
 * falls back to its own recent baseline. That matters most on a wall of
 * ninety: every tile means the same thing, so "needle in the colour" reads
 * correctly without stopping to check any tile's numbers.
 */
function TenantTile({ tenant, nowMs, onOpen }) {
  const primary = primaryTag(tenant)
  const meter = meterTag(tenant)
  const offline = tenant.alarm === 'offline'

  const scale = primary && gaugeScale({
    value: primary.entry.v,
    lo: primary.entry.lo ?? null,
    hi: primary.entry.hi ?? null,
    // Supplied by the server rather than derived here: this page holds no
    // sample history for ninety tenants and is never going to.
    stats: (typeof primary.entry.mean === 'number' && typeof primary.entry.hw === 'number')
      ? { mean: primary.entry.mean, halfWidth: primary.entry.hw }
      : null,
  })

  return (
    <button
      type="button"
      className={`tenant-tile alarm-${tenant.alarm}`}
      onClick={() => onOpen?.(tenant.id)}
      title={`Open ${tenant.name}`}
    >
      {scale ? (
        <TagGauge
          scale={scale}
          alarm={offline ? 'unknown' : tenant.alarm}
          stale={offline}
          label={`${tenant.name}: ${primary.entry.v} ${primary.key}`}
        >
          <span className="card-number">{primary.entry.v.toFixed(2)}</span>
          <span className="card-unit">{primary.key}</span>
        </TagGauge>
      ) : (
        <div className="tenant-nodial">
          {primary
            ? <><b>{primary.entry.v.toFixed(2)}</b> {primary.key}</>
            : <span className="mall-val-none">no reading</span>}
        </div>
      )}

      {/* The threshold in words as well as on the arc. The panel meters this
          replaces print only the words and leave the dial unmarked, which
          tells you the number but never how close you are to it. */}
      {primary && (primary.entry.hi != null || primary.entry.lo != null) && (
        <div className="tenant-limit">
          {primary.entry.lo != null && <span className="lim-lo">Low {primary.entry.lo}</span>}
          {primary.entry.hi != null && <span className="lim-hi">High {primary.entry.hi}</span>}
        </div>
      )}

      <div className="tenant-meter">
        {meter ? <><b>{meter.entry.v.toLocaleString()}</b> kWh</> : <span>&nbsp;</span>}
        {tenant.kwh?.deltaKwh != null && (
          <span className="tenant-today"> · {tenant.kwh.deltaKwh.toFixed(1)} today</span>
        )}
        {/* A reset makes the day's delta meaningless, so it is flagged
            rather than quietly billed. */}
        {tenant.kwh?.resetSuspected && <em className="mall-warn"> meter reset</em>}
      </div>

      <div className="tenant-name">{tenant.name}</div>

      <div className="tenant-state">
        {offline
          ? (tenant.lastSeen ? `offline ${formatAgo(nowMs - tenant.lastSeen)}` : 'never reported')
          : tenant.alarm === 'high' ? 'above threshold'
          : tenant.alarm === 'low' ? 'below threshold'
          : 'ok'}
      </div>
    </button>
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
