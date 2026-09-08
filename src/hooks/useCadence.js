import { useEffect, useRef, useState } from 'react'
import { DEFAULT_PERIOD_MS } from '../lib/health'
import { MINUTE } from '../lib/time'

const KEEP = 20        // recent gaps retained for the estimate
const MAX_GAP = 10 * MINUTE // longer than this was an outage, not a cadence

/**
 * Estimate the real publish period by watching how often `lastSeen` advances.
 *
 * The brief says the 5s interval may change and that staleness should be
 * derived rather than assumed, so the dashboard measures instead of trusting.
 *
 * Median, not mean: one outage inserts a single enormous gap that would drag a
 * mean far enough to mask genuine staleness for minutes afterwards. Gaps beyond
 * MAX_GAP are discarded outright — they describe a failure, not a rhythm.
 */
export function useCadence(lastSeen) {
  const gaps = useRef([])
  const previous = useRef(null)
  const [periodMs, setPeriodMs] = useState(DEFAULT_PERIOD_MS)

  useEffect(() => {
    if (typeof lastSeen !== 'number') return
    if (previous.current === lastSeen) return // same write, re-rendered

    if (previous.current != null) {
      const gap = lastSeen - previous.current
      if (gap > 0 && gap <= MAX_GAP) {
        gaps.current = [...gaps.current, gap].slice(-KEEP)

        // Two samples is enough to beat the default; below that, keep it.
        if (gaps.current.length >= 2) {
          const sorted = [...gaps.current].sort((a, b) => a - b)
          setPeriodMs(sorted[Math.floor(sorted.length / 2)])
        }
      }
    }

    previous.current = lastSeen
  }, [lastSeen])

  return periodMs
}
