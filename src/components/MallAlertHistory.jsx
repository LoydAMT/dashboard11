import { useMemo } from 'react'
import { alertsConfigured } from '../lib/alertsApi'
import { useMallOverview } from '../hooks/useMallOverview'
import { AlertLog } from './AlertLog'
import { BackButton } from './BackButton'

/**
 * Every alert across every tenant of one company, newest first.
 *
 * WHY THIS IS NOT THE STRIP ON THE MALL PAGE
 * That strip shows each tenant's MOST RECENT transition and nothing else -
 * bounded by tenant count, and the right thing for "what is happening now".
 * This is the record: the complete log, written by the sweep whether or not
 * anyone was signed in, filterable and paged back as far as it goes.
 *
 * Tenant names and the reading list come from the overview node the mall
 * page already reads - one subscription, not one per tenant.
 */
export function MallAlertHistory({ companyId, companyName, onClose, onOpenDevice, nowMs }) {
  const { tenants } = useMallOverview(companyId)

  const people = useMemo(() => tenants.map((t) => ({ id: t.id, name: t.name })), [tenants])
  const readings = useMemo(() => {
    const keys = new Set()
    for (const t of tenants) for (const k of Object.keys(t.values || {})) keys.add(k)
    // The accumulator never raises a reading alert of its own, so offering
    // it as a filter would only ever produce an empty page.
    return [...keys].filter((k) => !/kwh/i.test(k)).sort()
  }, [tenants])

  return (
    <div className="subpage">
      <BackButton onClick={onClose}>{companyName || 'All tenants'}</BackButton>

      <header className="subpage-head">
        <h2>All alerts</h2>
        <p className="subpage-sub">
          Every tenant in {companyName || 'this company'}, newest first. Recorded on the
          server, so it includes what happened while nobody was signed in.
        </p>
      </header>

      {!alertsConfigured() ? (
        <div className="notice notice-warn">
          <p>
            VITE_ALERTS_API_URL is not set for this build, so the server-side
            log cannot be read. Live alerts still work; only the history is missing.
          </p>
        </div>
      ) : (
        <AlertLog
          scope={{ company: companyId }}
          tenants={people}
          readings={readings}
          nowMs={nowMs}
          onOpenDevice={onOpenDevice}
        />
      )}
    </div>
  )
}
