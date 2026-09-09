import { useMemo } from 'react'
import { useRtdbValue } from './useRtdbValue'

/**
 * Which devices a signed-in account may see, read from access/{uid}.
 *
 * That node is navigation data, not the security boundary - the database
 * rules never reference it, only devices/{deviceId}/viewers|operators (and
 * the global admins/ list) do. It exists purely so this hook has something to
 * ask "which devices" without a way to query "which devices list my uid" the
 * other way around. Because of that split, access/ can in principle drift
 * from the real per-device grants (an admin mirrors both by hand and can miss
 * one), so a PERMISSION_DENIED reading a *device's* data later - handled
 * where that read happens, not here - is an expected outcome of that drift,
 * not a bug.
 *
 * This hook's own read, by contrast, is never denied for a real signed-in
 * user: the rule on access/$uid only requires auth.uid === $uid, true
 * regardless of whether anything is listed there yet. A denial here would
 * mean something more fundamental is wrong (rules not deployed, wrong
 * project) - folded into `error` rather than silently treated as "no
 * devices", so that distinction is not lost.
 */
export function useDeviceAccess(user) {
  const enabled = Boolean(user)
  const access = useRtdbValue(enabled ? `access/${user.uid}` : null, enabled)

  const devices = useMemo(() => {
    if (!access.data) return []
    return Object.entries(access.data)
      .filter(([, role]) => role === 'viewer' || role === 'operator')
      .map(([id, role]) => ({ id, role }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }, [access.data])

  return {
    loading: access.loading,
    error: access.error,
    devices,
  }
}
