import { useState } from 'react'
import { useRtdbValue } from '../hooks/useRtdbValue'
import { useMallOverview, rankTenants, visibleTags, recentAlerts } from '../hooks/useMallOverview'
import { useCompany } from '../hooks/useCompanies'
import { gaugeScale } from '../lib/gauge'
import { TagGauge } from './TagGauge'
import { formatAgo } from '../lib/time'
import { BackButton } from './BackButton'

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
export function MallOverview({ companyId, companyName, onOpenDevice, onClose, nowMs, onOpenLog }) {
  const [sortKey, setSortKey] = useState('attention')
  // Which reading each tenant shows on its dial, chosen by clicking one of
  // the numbers on the tile. Per VIEWER, not per company: two people can
  // reasonably want to watch different things on the same wall, and this is
  // a preference rather than a fact about the site.
  const [picks, setPicks] = useState(() => loadPicks(companyId))
  const pick = (deviceId, tagKey) => {
    setPicks((prev) => {
      const next = { ...prev, [deviceId]: tagKey }
      savePicks(companyId, next)
      return next
    })
  }
  const { loading, error, tenants, totals, updatedAt } = useMallOverview(companyId)
  // One read for the whole estate's display preferences, set on the admin
  // page. Per-device reads would be the fan-out this page exists to avoid.
  const display = useRtdbValue('mallDisplay', true)

  if (error) {
    return (
      <div className="notice notice-warn">
        <h2>Overview unavailable</h2>
        <p>Could not read this company&apos;s overview: {error.message || String(error)}</p>
        {onClose && <BackButton onClick={onClose}>Back to dashboard</BackButton>}
      </div>
    )
  }

  const rows = rankTenants(tenants, sortKey)
  const recent = recentAlerts(tenants)
  const needsAttention = (totals?.inAlarm || 0) + (totals?.offline || 0)

  return (
    <div className="mall">
      {onClose && <BackButton onClick={onClose}>Back to dashboard</BackButton>}
      <div className="mall-head">
        <div>
          <h2>{companyName || 'All tenants'}</h2>
          <p className="mall-sub">
            {totals ? `${totals.tenants} tenant${totals.tenants === 1 ? '' : 's'}` : '—'}
            {updatedAt != null && ` · updated ${formatAgo(nowMs - updatedAt)}`}
          </p>
        </div>
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
          <div className="mall-recent-head">
            <h3>Recent alerts</h3>
            {/* The strip is each tenant's LATEST event only. The full log
                is a different thing and says so. */}
            <button type="button" className="mall-recent-all" onClick={onOpenLog}>
              View all alerts →
            </button>
          </div>
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

      {/* Reachable even on a quiet site, where no tenant has a lastAlert
          yet and the strip above does not render at all. */}
      {recent.length === 0 && (
        <p className="mall-empty mall-empty-log">
          No recent alerts. <button type="button" className="mall-recent-all"
            onClick={onOpenLog}>View all alerts →</button>
        </p>
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
        {rows.map((t, i) => (
          <TenantTile
            key={t.id}
            tenant={t}
            nowMs={nowMs}
            onOpen={onOpenDevice}
            live={i < LIVE_TILE_LIMIT}
            chosen={display.data?.[t.id] || null}
            picked={picks[t.id]}
            onPick={pick}
          />
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
function TenantTile({ tenant, nowMs, onOpen, live, chosen, picked, onPick }) {
  // LIVE OVERLAY. The projection refreshes every two minutes, which is fine
  // for "which unit needs attention" and visibly wrong for a wall of
  // needles - they sat still while the single-device dashboard moved every
  // second. So the tiles on screen also subscribe to their own latest/ and
  // draw that over the projected value.
  //
  // Capped by the caller, not done for every tenant: ninety live
  // subscriptions is exactly the fan-out the projection exists to avoid.
  // The projection still supplies everything else - thresholds, scale,
  // alert state, the daily meter figure - so a tenant past the cap is a
  // slightly staler needle, not a broken tile.
  const liveLatest = useRtdbValue(live ? `devices/${tenant.id}/latest` : null, live)
  const merged = mergeLive(tenant, liveLatest.data)

  const shown = visibleTags(merged, chosen)
  // The viewer's own pick wins over the configured default, and falls back
  // to it the moment that tag stops reporting - a tile must not go blank
  // because someone once clicked a reading the box no longer sends.
  const selectedKey = shown.some((t) => t.key === picked) ? picked : shown[0]?.key
  const primary = shown.find((t) => t.key === selectedKey) || null
  const others = shown.filter((t) => t.key !== selectedKey)
  const offline = tenant.alarm === 'offline'
  const unit = primary?.entry.u || primary?.key || ''

  const scale = primary && gaugeScale({
    value: primary.entry.v,
    lo: primary.entry.lo ?? null,
    hi: primary.entry.hi ?? null,
    // The range this tag has actually been seen in, measured server-side
    // from the minute rollups. Supplied rather than derived here because
    // this page holds no sample history for ninety tenants.
    range: (typeof primary.entry.rmin === 'number' && typeof primary.entry.rmax === 'number')
      ? { min: primary.entry.rmin, max: primary.entry.rmax }
      : null,
  })

  return (
    // NOT a button. The readings inside are buttons now, and a button inside
    // a button is invalid HTML that browsers resolve by dropping one of
    // them - usually the inner one, which is the one that matters here.
    <div className={`tenant-tile alarm-${tenant.alarm}`}>
      <button
        type="button"
        className="tenant-open"
        onClick={() => onOpen?.(tenant.id)}
        title={`Open ${tenant.name}`}
      >
        {scale ? (
          <TagGauge
            compact
            scale={scale}
            alarm={offline ? 'unknown' : tenant.alarm}
            stale={offline}
            label={`${tenant.name}: ${primary.entry.v} ${unit}`}
          >
            <span className="card-number">{fmt(primary.entry.v)}</span>
            <span className="card-unit">{unit}</span>
          </TagGauge>
        ) : (
          // An accumulator has no range to sit inside, so it gets no arc -
          // a dial of a number that only ever rises would read full for
          // ever. Promoting kWh to the dial is still allowed; it simply
          // shows as a large number.
          <div className="tenant-nodial">
            {primary
              ? <><b>{fmt(primary.entry.v)}</b> <span className="tenant-nodial-u">{unit}</span></>
              : <span className="mall-val-none">no reading</span>}
          </div>
        )}

        {/* Always rendered, even when empty, so every tile is the same
            height and the wall reads as a grid rather than a ragged stack. */}
        <span className="tenant-limit">
          {primary?.entry.lo != null && <span className="lim-lo">Low {primary.entry.lo}</span>}
          {primary?.entry.hi != null && <span className="lim-hi">High {primary.entry.hi}</span>}
          {primary && primary.entry.lo == null && primary.entry.hi == null && (
            <span className="lim-none">no alerts set</span>
          )}
        </span>
      </button>

      {/* Every other reading, each one a button that promotes it to the
          dial. One dial per tile, because three arcs at this size is
          unreadable - but which one is the viewer's choice, not a guess. */}
      <div className="tenant-readings">
        {others.map((t) => (
          <button
            key={t.key}
            type="button"
            className="tenant-reading"
            onClick={() => onPick(tenant.id, t.key)}
            title={`Show ${t.key} on the dial`}
          >
            <b>{fmt(t.entry.v)}</b> {t.entry.u || t.key}
          </button>
        ))}
      </div>

      {/* The day's consumption, not the meter total - a different number
          from the kWh reading above, and the one a landlord bills on. */}
      {tenant.kwh?.deltaKwh != null && (
        <div className="tenant-meter">
          <b>{tenant.kwh.deltaKwh.toFixed(1)}</b> kWh today
          {/* A reset makes the day's delta meaningless, so it is flagged
              rather than quietly billed. */}
          {tenant.kwh.resetSuspected && <em className="mall-warn"> meter reset</em>}
        </div>
      )}

      <button
        type="button"
        className="tenant-name"
        onClick={() => onOpen?.(tenant.id)}
        title={`Open ${tenant.name}`}
      >
        {tenant.name}
      </button>

      {/* Only when something is wrong. A wall of tiles each captioned "ok"
          is noise that makes the one saying otherwise harder to spot. */}
      {tenant.alarm !== 'ok' && (
        <div className="tenant-state">
          {offline
            ? (tenant.lastSeen ? `offline ${formatAgo(nowMs - tenant.lastSeen)}` : 'never reported')
            : tenant.alarm === 'high' ? 'above threshold' : 'below threshold'}
        </div>
      )}
    </div>
  )
}

/**
 * Dial choices, remembered per browser.
 *
 * localStorage, not the database: this is one viewer's preference about how
 * to look at the wall, it never needs to reach anyone else, and writing it
 * server-side would put a database round trip behind a click that should be
 * instant. Every access is guarded because a private window, blocked site
 * data or a thumbnail capture can make these throw rather than return
 * empty, and a tile must still render when they do.
 */
const PICKS_KEY = (companyId) => `mallPicks:${companyId}`

function loadPicks(companyId) {
  try {
    const raw = localStorage.getItem(PICKS_KEY(companyId))
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function savePicks(companyId, picks) {
  try {
    localStorage.setItem(PICKS_KEY(companyId), JSON.stringify(picks))
  } catch {
    // A pick that cannot be remembered still works for this session.
  }
}

/**
 * How many tiles hold their own live subscription.
 *
 * Sized so an ordinary site is entirely live while a large mall degrades to
 * the two-minute projection rather than opening a connection per tenant.
 * The ordering puts whatever needs attention first, so the tiles that keep
 * updating are the ones worth watching.
 */
const LIVE_TILE_LIMIT = 24

/**
 * The projected row with any live readings laid over it.
 *
 * Only the VALUE is replaced. Thresholds, the observed range, the unit and
 * the alert state all stay as projected - they are server-side facts, and
 * recomputing a scale from a single live sample would make the dial jump
 * about for no reason.
 */
function mergeLive(tenant, latest) {
  if (!latest) return tenant
  const values = { ...tenant.values }
  for (const [k, v] of Object.entries(latest)) {
    if (!v || typeof v.value !== 'number' || !Number.isFinite(v.value)) continue
    values[k] = { ...(values[k] || {}), v: v.value }
  }
  return { ...tenant, values }
}

/**
 * Two decimals for a small reading, none for a large one - "231.87 V" wastes
 * the space a tile does not have, and "0.04 A" needs it.
 */
function fmt(v) {
  const a = Math.abs(v)
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2)
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
