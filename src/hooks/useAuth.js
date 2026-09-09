import { useEffect, useState } from 'react'
import { canControl, watchAuth } from '../auth'

/**
 * Hold the signed-in Firebase user - identity only, nothing about what that
 * identity is allowed to see.
 *
 * That split is deliberate. "Is this a real, non-anonymous sign-in" and "does
 * this account have access to a given device" are answered by different data
 * (the Firebase user object here; the devices/{deviceId}/viewers|operators
 * and access/{uid} nodes elsewhere) and can fail for different reasons an
 * operator needs to tell apart. Device-level access lives in
 * useDeviceAccess, which takes the `user` this hook returns as its input -
 * collapsing the two into one hook would hide which failure is which, the
 * same reason this hook used to keep `realUser` distinct from an
 * authorization flag before device-scoped access existed at all.
 */
export function useAuth() {
  const [user, setUser] = useState(null)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    const unsubscribe = watchAuth((u) => {
      setUser(u)
      setResolved(true)
    })
    return unsubscribe
  }, [])

  return {
    user,
    resolved,
    // A genuine, non-anonymous sign-in. False before anyone has signed in,
    // or (should it ever happen) for an anonymous session.
    realUser: canControl(user),
  }
}
