import { useEffect, useState } from 'react'

/**
 * Whether this tab is worth streaming live data to.
 *
 * Every open listener is billed for each byte it receives, whether or not
 * anyone is looking. A wall left in a background tab all day costs the same as
 * one on screen. This turns false once the tab has been hidden for `graceMs`,
 * and true again the instant it is shown, so the caller can detach its
 * listeners while nobody can see them and re-attach on return.
 *
 * The grace period stops a quick alt-tab from tearing every listener down and
 * paying to fetch it all again a second later.
 *
 * KIOSK OPT-OUT: add ?kiosk=1 to the address. A display that must keep
 * refreshing even when the browser reports the page hidden (some TV/signage
 * setups do) then never pauses.
 */
export function usePageActive(graceMs = 60000) {
  const [active, setActive] = useState(() => !isHidden())
  const [kiosk] = useState(isKiosk)

  useEffect(() => {
    if (kiosk) return undefined

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
  }, [graceMs, kiosk])

  return kiosk || active
}

function isHidden() {
  return typeof document !== 'undefined' && document.hidden === true
}

function isKiosk() {
  try {
    return new URLSearchParams(window.location.search).has('kiosk')
  } catch {
    return false
  }
}
