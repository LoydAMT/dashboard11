import { useMemo } from 'react'
import { useRtdbValue } from './useRtdbValue'

/**
 * Which companies a signed-in account belongs to, from userCompanies/{uid}.
 *
 * Same kind of node as access/{uid}: a navigation index, not the security
 * boundary. Both are written by the projectCompanyAccess Cloud Function from
 * the one source of truth (companies/ + companyMembers/), which is the
 * reason they can no longer drift apart the way a hand-mirrored pair did.
 *
 * Like access/{uid}, the rule here only requires auth.uid === $uid, so an
 * account with no companies reads an empty node rather than being denied -
 * "belongs to nothing yet" renders as a calm empty state.
 *
 * An admin legitimately has no entry here: admins/ grants every device
 * directly, without company membership. That is why the caller must treat an
 * empty result as "not grouped", never as "no access".
 */
export function useCompanies(user) {
  const enabled = Boolean(user)
  const index = useRtdbValue(enabled ? `userCompanies/${user.uid}` : null, enabled)

  const companyIds = useMemo(() => {
    if (!index.data) return []
    return Object.entries(index.data)
      .filter(([, v]) => v === true)
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b))
  }, [index.data])

  return { loading: index.loading, error: index.error, companyIds }
}

/**
 * One company's display name and device list.
 *
 * Kept as its own hook so a caller can render a row per company without
 * calling hooks in a loop - the same pattern DevicePicker already uses for
 * per-device naming.
 *
 * A denial here is expected rather than exceptional: a company can be read
 * by its own members, so an admin who is not a member of a company they can
 * otherwise see every device of will be refused this particular node. The
 * caller falls back to showing the device ungrouped.
 */
export function useCompany(companyId) {
  const enabled = Boolean(companyId)
  const name = useRtdbValue(enabled ? `companies/${companyId}/name` : null, enabled)
  const devices = useRtdbValue(enabled ? `companies/${companyId}/devices` : null, enabled)

  const deviceIds = useMemo(() => {
    if (!devices.data) return []
    return Object.entries(devices.data)
      .filter(([, v]) => v === true)
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b))
  }, [devices.data])

  return {
    name: typeof name.data === 'string' && name.data.length > 0 ? name.data : companyId,
    deviceIds,
    loading: name.loading || devices.loading,
  }
}
