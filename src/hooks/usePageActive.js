import { useEffect, useState } from 'react'

/**
 * Whether this tab is worth streaming live data to, when the viewer has asked
 * for hidden tabs to be paused.
 *
 * OFF BY DEFAULT. A tab the browser calls "hidden" is not always unseen - a
 * window covered by another, or a wall on a second monitor, can report
 * hidden while someone is still reading it, and live readings matter more
 * here than the bandwidth. Add ?pausehidden=1 to the address to turn the
 * pause on for a tab that is genuinely out of sight (a background tab left
 * open all day). The unattended-tab pause in useIdlePause covers the common
 * case without this.
 *
 * When on, this turns false once the tab has been hidden for `graceMs` and
 * true again the instant it is shown, so the caller can detach its listeners
 * while nobody can see them and re-attach on return. ?kiosk=1 always wins and
 * never pauses.
 */
export function usePageActive(graceMs = 60000) {
  const [active, setActive] = useState(() => !isHidden())
  const [enabled] = useState(() => hasParam('pausehidden') && !hasParam('kiosk'))

  useEffect(() => {
    if (!enabled) return undefined

    let timer = null
    const onChange = () => {
      clearTimeout(timer)
      if (!isHidden()) {
        setActive(true)
        return
      }
      timer = setTimeout(() => setActive(false), graceMs)
    }

    document.addEventListener('visibilitychange', onChange)
    onChange()
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onChange)
    }
  }, [graceMs, enabled])

  return !enabled || active
}

function isHidden() {
  return typeof document !== 'undefined' && document.hidden === true
}

export function hasParam(name) {
  try {
    return new URLSearchParams(window.location.search).has(name)
  } catch {
    return false
  }
}
