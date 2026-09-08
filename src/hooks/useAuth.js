import { useEffect, useState } from 'react'
import { canControl, ensureSignedIn, watchAuth } from '../auth'

/**
 * Hold a signed-in user, so data subscriptions know when they may start.
 *
 * Deliberately says nothing about *how* the user signed in. Swapping anonymous
 * auth for real accounts is a change to auth.js alone.
 */
export function useAuth() {
  const [user, setUser] = useState(null)
  const [error, setError] = useState(null)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    const unsubscribe = watchAuth((u) => {
      setUser(u)
      setResolved(true)
      if (!u) {
        ensureSignedIn().catch(setError)
      }
    })
    return unsubscribe
  }, [])

  return {
    user,
    error,
    ready: Boolean(user),
    resolved,
    // Kept beside `ready` so the difference is impossible to miss at the call
    // site: `ready` means data may be read, `mayControl` means equipment may
    // be moved. They are the same test today and must not stay that way.
    mayControl: canControl(user),
  }
}
