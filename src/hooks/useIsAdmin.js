import { useRtdbValue } from './useRtdbValue'

/**
 * Whether this account is a global admin - listed in admins/{uid}, granting
 * every device rather than one at a time. Kept separate from useDeviceAccess:
 * admins/ has nothing to do with access/{uid}, the per-device navigation
 * index that hook reads - a pure admin with no explicit viewer/operator
 * grant anywhere would have an empty access/ entry despite this being true,
 * which is why device *discovery* for a pure admin isn't handled by the
 * picker today (see the note in useDeviceAccess). This hook only answers
 * "is this uid on the admin list", for whichever device is already selected
 * by some other means.
 */
export function useIsAdmin(user) {
  const enabled = Boolean(user)
  const admin = useRtdbValue(enabled ? `admins/${user.uid}` : null, enabled)
  return admin.data === true
}
