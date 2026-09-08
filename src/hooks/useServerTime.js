import { useEffect, useRef, useState } from 'react'
import { ref, onValue } from 'firebase/database'
import { db } from '../firebase'

/**
 * Milliseconds to add to this device's clock to get the database's.
 *
 * This matters more here than anywhere else in the app. The RH-W discards any
 * command that is already more than 30 seconds old when it first sees it,
 * judged against issuedAt. Stamp that from a phone whose clock is two minutes
 * slow and every command it ever sends is thrown away as stale, with nothing on
 * either side of the exchange to explain why. Stamping in server time takes the
 * operator's clock out of the decision entirely.
 *
 * `.info/serverTimeOffset` is local to the SDK and needs no auth, and it is
 * kept in a ref as well as state so a send in progress reads the current value
 * without having to list it as a dependency.
 */
export function useServerTimeOffset() {
  const [offset, setOffset] = useState(0)
  const ref_ = useRef(0)

  useEffect(() => {
    if (!db) return
    return onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
      const v = snap.val()
      const next = typeof v === 'number' && Number.isFinite(v) ? v : 0
      ref_.current = next
      setOffset(next)
    })
  }, [])

  return { offset, offsetRef: ref_ }
}
