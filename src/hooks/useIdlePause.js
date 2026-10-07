import { useCallback, useEffect, useRef, useState } from 'react'
import { hasParam } from './usePageActive'

/**
 * Pauses the expensive live streams on a tab nobody is using.
 *
 * UNATTENDED means no pointer, keyboard, wheel or touch input for `idleMs`.
 * Once that has passed `paused` turns true, and it stays true until the viewer
 * clicks or touches the page (through PausedNotice) or presses a key - a
 * mouse merely drifting across the screen does not resume it, so a bump of
 * the desk cannot restart the stream on a tab nobody is looking at.
 *
 * WHAT THE CALLER SHOULD PAUSE, and what it should not: the per-tile live
 * overlay is the expensive part (a message per tile every few seconds). The
 * summary that carries alarm state, alert counts and the latest alert is
 * cheap and must keep flowing, so an unattended wall still turns red the
 * moment something is wrong. Pausing is for the nice-to-have, never for the
 * alarm.
 *
 * ?kiosk=1 on the address means this tab is a display that is MEANT to be
 * unattended (a wall, a TV): it never pauses. Any wall display needs it.
 */
export function useIdlePause(idleMs = 5 * 60000) {
  const [paused, setPaused] = useState(false)
  const [kiosk] = useState(() => hasParam('kiosk'))
  const lastActivity = useRef(0)
  const pausedRef = useRef(false)

  const resume = useCallback(() => {
    lastActivity.current = Date.now()
    pausedRef.current = false
    setPaused(false)
  }, [])

  useEffect(() => {
    if (kiosk) return undefined
    lastActivity.current = Date.now()

    // Cheap to run on every input: one timestamp write, no state, no timer.
    const touch = () => {
      if (!pausedRef.current) lastActivity.current = Date.now()
    }
    // A key press resumes a paused tab. A click or touch does NOT resume
    // here: it resumes through the notice's own click handler
    // (PausedNotice), which consumes it. Resuming on pointer-down instead
    // would remove the notice before the click finished, and that click
    // would land on the tile underneath.
    const wake = () => {
      if (pausedRef.current) resume()
    }

    const inputs = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']
    for (const e of inputs) window.addEventListener(e, touch, { passive: true })
    window.addEventListener('keydown', wake, { passive: true })

    // Checked every 10 s (less for a short idleMs) rather than with one long
    // timer, because a laptop that slept for an hour must notice on waking,
    // not 5 minutes later.
    const check = setInterval(() => {
      if (!pausedRef.current && Date.now() - lastActivity.current >= idleMs) {
        pausedRef.current = true
        setPaused(true)
      }
    }, Math.min(10000, Math.max(50, idleMs / 4)))

    return () => {
      clearInterval(check)
      for (const e of inputs) window.removeEventListener(e, touch)
      window.removeEventListener('keydown', wake)
    }
  }, [idleMs, kiosk, resume])

  return { paused: !kiosk && paused, resume }
}
