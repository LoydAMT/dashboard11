import { useEffect, useState } from 'react'
import { canControl, watchAuth } from '../auth'
import { useRtdbValue } from './useRtdbValue'

/**
 * Hold the signed-in user and whether this session is actually allowed to use
 * the app, so data subscriptions and the VFD control know when they may start.
 *
 * "Allowed" is two separate checks, on purpose, because they can fail for
 * different reasons an operator needs to tell apart:
 *   - realUser: a genuine, non-anonymous Firebase sign-in. False before
 *     anyone has signed in, or (should it ever happen) for an anonymous
 *     session - see canControl in auth.js.
 *   - authorized: that identity is on the authorized/{uid} allowlist in the
 *     database. A real sign-in is not enough by itself - see the note on
 *     that node in database.rules.json for why self-registration through the
 *     Email/Password provider means "not anonymous" alone would not have
 *     kept an uninvited account out.
 *
 * `ready`/`mayControl` fold both into the one signal the rest of the app
 * actually needs ("may this session touch the database"), while `realUser`
 * and `authLoading` stay available so App.jsx can tell "still checking" from
 * "checked, and no" and show the right screen for each.
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

  const realUser = canControl(user)

  // Only ever this session's own entry - matches the narrow read rule on
  // authorized/$uid, which exists specifically so a session can check its own
  // status without already needing to be authorized to do so.
  const authorization = useRtdbValue(realUser ? `authorized/${user.uid}` : null, realUser)
  const authLoading = realUser && authorization.loading
  const authorized = realUser && authorization.data === true

  return {
    user,
    resolved,
    realUser,
    authLoading,
    ready: realUser && authorized,
    // Kept as its own name, not just an alias for `ready`, so a call site
    // asking "may equipment be moved" reads as that question even though the
    // two happen to share one test today.
    mayControl: realUser && authorized,
  }
}
