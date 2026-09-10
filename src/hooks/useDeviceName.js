import { useRtdbValue } from './useRtdbValue'

/**
 * A device's display name - naming/{deviceId} if one has been set, else the
 * raw id itself. Shared across every signed-in account, unlike an earlier
 * version of this that lived in localStorage: the whole point is that a
 * rename shows up for everyone who can see the device, not just the browser
 * that set it. devices/{deviceId} itself is never touched by this - the raw
 * id is still what every path, rule and export filename uses.
 *
 * Read access to naming/{deviceId} mirrors the device's own telemetry (see
 * database.rules.json) - a viewer sees the same name an operator does.
 * Nothing here writes; only /naming (components/NamingPage.jsx) does that,
 * gated to one hardcoded account both client-side and, the boundary that
 * actually matters, in the rules.
 */
export function useDeviceName(deviceId) {
  const node = useRtdbValue(deviceId ? `naming/${deviceId}` : null, Boolean(deviceId))
  return {
    name: node.data || deviceId,
    loading: node.loading,
  }
}
