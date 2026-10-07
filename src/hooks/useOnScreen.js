import { useEffect, useState } from 'react'

/**
 * Whether an element is on screen, or within `margin` of it.
 *
 * Lets a tile that has scrolled out of view stop holding a live subscription.
 * Starts false, so an element that is never visible never subscribes at all.
 * Where IntersectionObserver is missing it reports true, which is the old
 * behaviour: everything stays live.
 */
export function useOnScreen(ref, margin = '200px') {
  // Without IntersectionObserver there is nothing to observe: stay true.
  const [onScreen, setOnScreen] = useState(() => typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(
      (entries) => setOnScreen(entries.some((e) => e.isIntersecting)),
      { rootMargin: margin },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, margin])

  return onScreen
}
