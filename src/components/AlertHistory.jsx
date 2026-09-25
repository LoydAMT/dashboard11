import { useMemo } from 'react'
import { alertsConfigured } from '../lib/alertsApi'
import { useRtdbValue } from '../hooks/useRtdbValue'
import { AlertLog } from './AlertLog'
import { BackButton } from './BackButton'

/**
 * The full alert record for one device, from the server.
 *
 * The bell (AlertBell) shows what this browser happened to witness while it
 * was open. This shows what actually happened - including everything that
 * occurred overnight with nobody signed in, which the bell can never know
 * about. They are deliberately separate: one is a live notifier, this is
 * the log you go back to.
 *
 * Uses the same AlertLog as the mall-wide history, so a tenant's own page
 * filters exactly the way the landlord's does - on the server, not over
 * whatever page happened to be loaded.
 */
export function AlertHistory({ deviceId, onClose, nowMs }) {
  const tags = useRtdbValue(deviceId ? `devices/${deviceId}/tags` : null, Boolean(deviceId))

  // Readings to offer as a filter. The accumulator never raises an alert of
  // its own, so offering it would only ever produce an empty page.
  const readings = useMemo(
    () => Object.keys(tags.data || {}).filter((k) => !/kwh/i.test(k)).sort(),
    [tags.data],
  )

  return (
    <div className="subpage">
      {onClose && <BackButton onClick={onClose}>Back to dashboard</BackButton>}

      <header className="subpage-head">
        <h2>Alert history</h2>
        <p className="subpage-sub">
          Recorded on the server, so events that happened while nobody was signed
          in are here too. Kept for the life of the deployment.
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
        <AlertLog scope={{ device: deviceId }} readings={readings} nowMs={nowMs} />
      )}
    </div>
  )
}
