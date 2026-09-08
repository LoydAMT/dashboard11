import { useCallback, useEffect, useRef, useState } from 'react'
import { ref, runTransaction } from 'firebase/database'
import { db } from '../firebase'
import { useRtdbValue } from './useRtdbValue'
import { useServerTimeOffset } from './useServerTime'
import {
  ACK_TIMEOUT_MS,
  SUCCESS_HOLD_MS,
  isCommandValue,
  lastKnown,
  resolveAck,
} from '../lib/vfd'

// Terminal phases: the exchange is over and the buttons come back. None of them
// retries anything - by the time one of these is on screen the operator's
// intent may no longer be current, so the next command has to be a fresh press.
const SETTLED = new Set(['ok', 'stale', 'error', 'superseded', 'timeout', 'send-failed'])

/**
 * One command in flight, from press to verdict.
 *
 * `flight` is a single object rather than several booleans on purpose: a
 * control surface must never be able to render a combination like "sending" and
 * "confirmed" at once, and the cheapest way to guarantee that is to make the
 * states unrepresentable together.
 *
 *   null                                   nothing in flight
 *   { phase: 'sending', value }            write on its way to the database
 *   { phase: 'pending', value, seq, sentAt }  written; waiting for the box
 *   { phase: 'ok', ... }                   confirmed, briefly
 *   { phase: 'stale' | 'error' | 'superseded' | 'timeout' | 'send-failed', ... }
 */
export function useVfdCommand(deviceId, enabled) {
  const path = `commands/${deviceId}`

  // Subscribed continuously, not only while waiting. It supplies the resting
  // state, and it also keeps the node in the SDK's cache so the transaction
  // below starts from the real seq rather than from null.
  const node = useRtdbValue(path, enabled)
  const { offsetRef } = useServerTimeOffset()

  const [flight, setFlight] = useState(null)
  const busy = flight?.phase === 'sending' || flight?.phase === 'pending'

  // A second press can arrive before React has re-rendered with the disabled
  // buttons. State cannot be read soon enough to stop it; a ref can, kept in
  // sync via effect rather than assigned during render.
  const busyRef = useRef(false)
  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  const send = useCallback(
    async (value) => {
      if (!db || !isCommandValue(value) || busyRef.current) return
      busyRef.current = true
      setFlight({ phase: 'sending', value })

      try {
        const issuedAt = Date.now() + offsetRef.current

        // A transaction, not a set: seq must increment even if two operators
        // press at the same moment, and a lost increment would let the box see
        // an unchanged seq and skip a command it was meant to run.
        const result = await runTransaction(ref(db, path), (current) => {
          const prev = current && typeof current === 'object' ? current : {}
          const prevSeq = typeof prev.seq === 'number' && Number.isFinite(prev.seq) ? prev.seq : 0
          // Spread first so ack/ survives. This node is written whole, and
          // dropping the box's last ack would erase the only record of what the
          // drive was last confirmed to have been told.
          return { ...prev, seq: prevSeq + 1, value, issuedAt }
        })

        if (!result.committed) {
          setFlight({
            phase: 'send-failed',
            value,
            detail: 'The write was aborted before it reached the database.',
          })
          return
        }

        const seq = result.snapshot.val()?.seq
        if (typeof seq !== 'number') {
          setFlight({
            phase: 'send-failed',
            value,
            detail: 'The database accepted the write but returned no sequence number.',
          })
          return
        }

        // The seq is read back from the commit rather than guessed, so what we
        // match the ack against is the number the box will actually see.
        setFlight({ phase: 'pending', value, seq, sentAt: Date.now() })
      } catch (err) {
        setFlight({ phase: 'send-failed', value, detail: err?.message || String(err) })
      }
    },
    [path, offsetRef],
  )

  const dismiss = useCallback(() => {
    setFlight((f) => (f && SETTLED.has(f.phase) ? null : f))
  }, [])

  // Verdict. Derived from the current node rather than from a stream of events,
  // so an ack that lands between the commit and this render is still caught.
  useEffect(() => {
    if (flight?.phase !== 'pending') return
    const outcome = resolveAck(node.data?.ack, flight.seq)
    if (!outcome) return
    setFlight({ ...flight, ...outcome })
  }, [node.data, flight])

  // Silence. Timed from the send, not from when this effect happened to run.
  useEffect(() => {
    if (flight?.phase !== 'pending') return
    const remaining = Math.max(0, ACK_TIMEOUT_MS - (Date.now() - flight.sentAt))
    const id = setTimeout(() => {
      setFlight((f) => (f?.phase === 'pending' && f.seq === flight.seq ? { ...f, phase: 'timeout' } : f))
    }, remaining)
    return () => clearTimeout(id)
  }, [flight?.phase, flight?.seq, flight?.sentAt])

  // Success is shown briefly and then gives way to the resting state, which by
  // then says the same thing. Failures do not expire - they wait to be read.
  useEffect(() => {
    if (flight?.phase !== 'ok') return
    const id = setTimeout(() => setFlight(null), SUCCESS_HOLD_MS)
    return () => clearTimeout(id)
  }, [flight?.phase, flight?.seq])

  // Losing the session mid-exchange leaves us unable to hear the ack, so the
  // pending state would hang. Drop it rather than show a wait that cannot end.
  useEffect(() => {
    if (!enabled) setFlight(null)
  }, [enabled])

  return {
    known: lastKnown(node.data),
    flight,
    busy,
    settled: Boolean(flight && SETTLED.has(flight.phase)),
    send,
    dismiss,
    loading: node.loading,
    error: node.error,
  }
}
