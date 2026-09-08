import { useEffect, useState } from 'react'

/**
 * A ticking clock.
 *
 * Staleness is a function of elapsed time, not of incoming data — if the logger
 * dies, no snapshot ever arrives to trigger a re-render, and a dashboard driven
 * only by data events would sit there showing a confident green badge forever.
 * This is what makes the page notice silence.
 */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return now
}
