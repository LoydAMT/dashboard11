import { useCallback, useEffect, useRef, useState } from 'react'
import { ref, update } from 'firebase/database'
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
  // state, and its live seq is what send() below increments from - no read
  // happens at send time, only whatever this listener has already delivered.
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

  // send() reads this rather than closing over node.data directly, so the
  // callback's identity does not have to change on every snapshot.
  const nodeDataRef = useRef(node.data)
  useEffect(() => {
    nodeDataRef.current = node.data
  }, [node.data])

  const send = useCallback(
    async (value) => {
      if (!db || !isCommandValue(value) || busyRef.current) return
      busyRef.current = true
      setFlight({ phase: 'sending', value })

      try {
        const issuedAt = Date.now() + offsetRef.current
        const prevSeq = nodeDataRef.current?.seq
        const nextSeq = typeof prevSeq === 'number' && Number.isFinite(prevSeq) ? prevSeq + 1 : 1

        // A partial update, not a whole-node write: this touches only seq,
        // value and issuedAt, so ack/ - written solely by the box's Admin SDK -
        // is never part of the request. There is nothing here to read back or
        // keep unchanged, which was the earlier bug: a whole-node transaction
        // had to reconstruct ack from whatever the local cache happened to
        // hold, and if that cache had not yet synced (fresh page load, quick
        // repeat presses), the write silently omitted ack and the database's
        // own rule - correctly refusing to let a client erase it - rejected the
        // whole command with permission_denied. update() cannot lose a field it
        // never touches.
        //
        // If a second operator's press landed first, nextSeq will not match
        // what the server actually holds by the time this reaches it, and the
        // database's seq rule (must be exactly one more than the current
        // value) rejects it - caught below as send-failed, same as any other
        // write refusal. Pressing again reads the real seq and succeeds.
        await update(ref(db, path), { seq: nextSeq, value, issuedAt })

        setFlight({ phase: 'pending', value, seq: nextSeq, sentAt: Date.now() })
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
