import { useEffect, useRef, useState } from 'react'
import { loadLog, saveLog, makeAlert, isSpike } from '../lib/alerts'

const TOAST_LIFE_MS = { critical: 15000, warning: 10000, info: 6000 }
const SPIKE_WINDOW = 24

/**
 * Turns "the numbers changed" into "something happened worth telling someone
 * about" - a tag crossing an alert threshold, a live value jumping well outside its
 * own recent spread, or the link to Firebase dropping and coming back.
 *
 * Nothing here reads anything new from the database: every signal it watches
 * (`tag.value`/`tag.ts`/`tag.alarm`, and `connectionLevel`) is already being
 * read for the cards and the status banner. This only remembers the previous
 * tick, in refs, long enough to notice an edge - going from ok to alarmed,
 * live to disconnected, and back.
 *
 * `tags` must already carry `.alarm` ('ok' | 'high' | 'low' | 'unknown' |
 * 'none') and `.stale`, computed the same way TagCard computes them, so an
 * alarm/spike never fires against a frozen reading.
 *
 * Nothing fires on the very first tick for a given tag or connection state -
 * opening the dashboard onto an already-alarmed plant should not replay every
 * pre-existing condition as a fresh event.
 */
export function useAlertCenter({ deviceId, tags, connectionLevel, enabled }) {
  const [log, setLog] = useState(() => loadLog(deviceId))
  const [toasts, setToasts] = useState([])
  const [sessions, setSessions] = useState({}) // tagKey -> {episodes, closedMs, activeSince}

  useEffect(() => {
    setLog(loadLog(deviceId))
    setToasts([])
    setSessions({})
    prevAlarm.current = new Map()
    prevLevel.current = null
    buffers.current = new Map()
    lastTs.current = new Map()
  }, [deviceId])

  const prevAlarm = useRef(new Map())
  const prevLevel = useRef(null)
  const buffers = useRef(new Map())
  const lastTs = useRef(new Map())

  const record = (alert) => {
    setLog((prev) => {
      const next = [...prev, alert].slice(-300)
      saveLog(deviceId, next)
      return next
    })
    setToasts((prev) => [...prev, alert])
    const life = TOAST_LIFE_MS[alert.level] ?? TOAST_LIFE_MS.info
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== alert.id))
    }, life)
  }

  useEffect(() => {
    if (!enabled) return

    if (prevLevel.current != null && prevLevel.current !== connectionLevel) {
      if (connectionLevel === 'disconnected' && prevLevel.current !== 'disconnected') {
        record(makeAlert({
          kind: 'disconnected',
          level: 'critical',
          message: 'Lost connection to Firebase. Values on screen are no longer updating.',
        }))
      } else if (
        connectionLevel === 'live'
        && ['disconnected', 'stale', 'no-data'].includes(prevLevel.current)
      ) {
        record(makeAlert({
          kind: 'reconnected',
          level: 'info',
          message: 'Back online. Readings are updating again.',
        }))
      }
    }
    prevLevel.current = connectionLevel

    for (const tag of tags) {
      const prevA = prevAlarm.current.get(tag.key)
      if (prevA !== undefined && prevA !== tag.alarm) {
        const enteringAlarm = tag.alarm === 'high' || tag.alarm === 'low'
        const leavingAlarm = prevA === 'high' || prevA === 'low'

        if (enteringAlarm) {
          record(makeAlert({
            kind: tag.alarm === 'high' ? 'alarm-high' : 'alarm-low',
            level: 'critical',
            tagKey: tag.key,
            tagName: tag.name,
            message: `${tag.name} is ${tag.alarm === 'high' ? 'above its alert threshold' : 'below its alert threshold'}`
              + (tag.value != null ? ` (${tag.value}${tag.unit ? ` ${tag.unit}` : ''}).` : '.'),
          }))
          setSessions((prev) => {
            const s = prev[tag.key] || { episodes: 0, closedMs: 0, activeSince: null }
            return { ...prev, [tag.key]: { ...s, episodes: s.episodes + 1, activeSince: Date.now() } }
          })
        } else if (leavingAlarm) {
          record(makeAlert({
            kind: 'alarm-clear',
            level: 'info',
            tagKey: tag.key,
            tagName: tag.name,
            message: `${tag.name} is back within its normal range.`,
          }))
          setSessions((prev) => {
            const s = prev[tag.key]
            if (!s?.activeSince) return prev
            return {
              ...prev,
              [tag.key]: { ...s, closedMs: s.closedMs + (Date.now() - s.activeSince), activeSince: null },
            }
          })
        }
      }
      prevAlarm.current.set(tag.key, tag.alarm)

      // Live spike, sampled once per genuinely new push (by ts) rather than
      // once per render tick, so a 1s UI refresh does not treat one reading
      // as twenty samples.
      if (typeof tag.value === 'number' && Number.isFinite(tag.value) && tag.ts != null) {
        if (lastTs.current.get(tag.key) !== tag.ts) {
          lastTs.current.set(tag.key, tag.ts)
          const buf = buffers.current.get(tag.key) || []
          if (!tag.stale && tag.alarm !== 'high' && tag.alarm !== 'low' && isSpike(buf, tag.value)) {
            record(makeAlert({
              kind: 'spike',
              level: 'warning',
              tagKey: tag.key,
              tagName: tag.name,
              message: `${tag.name} jumped to ${tag.value}${tag.unit ? ` ${tag.unit}` : ''}, well outside its recent range.`,
            }))
          }
          buf.push(tag.value)
          if (buf.length > SPIKE_WINDOW) buf.shift()
          buffers.current.set(tag.key, buf)
        }
      }
    }
    // tags is rebuilt every render; only the values read above matter, and
    // each is compared against a ref rather than relied on for its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags, connectionLevel, enabled, deviceId])

  const dismissToast = (id) => setToasts((prev) => prev.filter((t) => t.id !== id))
  const clearLog = () => {
    setLog([])
    saveLog(deviceId, [])
  }

  return { toasts, dismissToast, log, clearLog, sessions }
}
