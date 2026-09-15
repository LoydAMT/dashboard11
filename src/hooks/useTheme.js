import { useCallback, useEffect, useState } from 'react'
import { storedTheme, storeTheme, systemTheme, applyTheme } from '../lib/theme'

/**
 * Explicit light/dark override. Starts from whatever the inline script in
 * index.html already painted the first frame with - reading the attribute
 * back rather than recomputing it here guarantees this can never disagree
 * with what the viewer already saw.
 *
 * Follows the OS setting live only until an explicit choice is made; once
 * someone picks a side there is nothing worse than the app quietly flipping
 * back because a phone's auto dark-mode schedule kicked in at sunset.
 */
export function useTheme() {
  const [theme, setThemeState] = useState(
    () => document.documentElement.dataset.theme || systemTheme(),
  )

  useEffect(() => {
    if (storedTheme()) return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const next = mq.matches ? 'dark' : 'light'
      applyTheme(next)
      setThemeState(next)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const setTheme = useCallback((next) => {
    applyTheme(next)
    storeTheme(next)
    setThemeState(next)
  }, [])

  return { theme, setTheme }
}
