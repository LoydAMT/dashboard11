import { useEffect, useState } from 'react'
import { ref, onValue } from 'firebase/database'
import { db } from '../firebase'

/**
 * Subscribe to a path with onValue and keep the latest snapshot in state.
 *
 * Push, not poll — the brief is explicit about this, and it is also the cheaper
 * option: after the initial payload the server sends only what changed.
 *
 * `enabled` exists so subscriptions can wait for sign-in. Attaching a listener
 * before auth resolves trips the security rules and surfaces a permission error
 * that looks like a broken dashboard rather than a normal startup race.
 *
 * The snapshot is stored together with the path it came from, and a result is
 * only returned when the two agree. Otherwise a path change would serve the
 * previous path's data until the new snapshot landed — briefly, but this is a
 * dashboard whose whole purpose is never to present old data as current.
 */
export function useRtdbValue(path, enabled = true) {
  const [snapshot, setSnapshot] = useState({ path: null, data: null, error: null })

  useEffect(() => {
    if (!enabled || !path) return

    const unsubscribe = onValue(
      ref(db, path),
      (snap) => setSnapshot({ path, data: snap.val(), error: null }),
      (error) => setSnapshot({ path, data: null, error }),
    )

    return unsubscribe
  }, [path, enabled])

  const settled = snapshot.path === path
  return {
    data: settled ? snapshot.data : null,
    error: settled ? snapshot.error : null,
    loading: !settled,
  }
}
