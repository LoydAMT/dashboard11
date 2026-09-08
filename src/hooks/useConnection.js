import { useEffect, useState } from 'react'
import { ref, onValue } from 'firebase/database'
import { db } from '../firebase'

/**
 * The `.info/connected` ref: whether this browser currently has a live socket
 * to the Realtime Database.
 *
 * This is the only way to tell "the numbers are not moving because the plant is
 * quiet" from "the numbers are not moving because this device fell off the
 * network". Both look identical on screen otherwise, and one of them means
 * everything you are reading is wrong.
 *
 * The node is local to the SDK and readable without auth, so this keeps working
 * even while sign-in is still pending.
 *
 * @returns true | false | null (null = not yet determined)
 */
export function useConnection() {
  const [connected, setConnected] = useState(null)

  useEffect(() => {
    return onValue(ref(db, '.info/connected'), (snap) => {
      setConnected(snap.val() === true)
    })
  }, [])

  return connected
}
