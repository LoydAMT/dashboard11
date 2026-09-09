import { useCallback, useEffect, useRef, useState } from 'react'
import { ref, update } from 'firebase/database'
import { db } from '../firebase'
import { useRtdbValue } from './useRtdbValue'
import { useServerTimeOffset } from './useServerTime'
import {
  ACK_TIMEOUT_MS,
  SUCCESS_HOLD_MS,
  isCommandValue,
  isPermissionDenied,
  lastKnown,
  resolveAck,
} from '../lib/vfd'

// Terminal phases: the exchange is over and the buttons come back. None of
// them retries anything - by the time one of these is on screen the
// operator's intent may no longer be current (stale/superseded), or a retry
// plainly would not help (denied), so the next command has to be a fresh
// press, not an automatic one.
const SETTLED = new Set(['ok', 'stale', 'error', 'superseded', 'timeout', 'send-failed', 'denied'])

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
 *   { phase: 'denied', value, atSend }     the database refused this account,
 *                                          at the write (atSend: true) or
 *                                          while waiting on the ack (false)
 */
export function useVfdCommand(deviceId, enabled) {
  const path = `devices/${deviceId}/commands`

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
        // value) rejects it. Pressing again reads the real seq and succeeds.
        //
        // That race and a real access denial both surface as the identical
        // PERMISSION_DENIED - Firebase does not say which rule clause
        // rejected the write, only that one did - so isPermissionDenied()
        // below cannot tell them apart with certainty. Routed to 'denied'
        // either way, but worded in VfdControl to name both possibilities
        // rather than confidently blaming access when it might have been a
        // lost race - a wrong-but-confident message would be worse than an
        // honestly ambiguous one.
        await update(ref(db, path), { seq: nextSeq, value, issuedAt })

        setFlight({ phase: 'pending', value, seq: nextSeq, sentAt: Date.now() })
      } catch (err) {
        if (isPermissionDenied(err)) {
          setFlight({ phase: 'denied', value, atSend: true })
        } else {
          setFlight({ phase: 'send-failed', value, detail: err?.message || String(err) })
        }
      }
    },
    [path, offsetRef],
  )

  const dismiss = useCallback(() => {
    setFlight((f) => (f && SETTLED.has(f.phase) ? null : f))
  }, [])

  // Verdict. Derived from the current node rather than from a stream of events,
  // so an ack that lands between the commit and this render is still caught.
  //
  // node.error is checked here too, and unlike the same check in send()'s
  // catch block, this one is unambiguous: the write that got this flight to
  // 'pending' already succeeded, so a denial appearing now on the read can
  // only mean access changed after that point - never a seq race, which
  // would have been rejected at send time, before 'pending' was ever
  // reached. Without this check the read would simply stop delivering
  // anything new, resolveAck would never fire, and the flight would sit
  // unexplained until the 20s timeout mislabels it as the box being
  // unreachable, when the real, permanent reason is this account no longer
  // being allowed to ask.
  useEffect(() => {
    if (flight?.phase !== 'pending') return
    if (node.error && isPermissionDenied(node.error)) {
      setFlight({ ...flight, phase: 'denied', atSend: false })
      return
    }
    const outcome = resolveAck(node.data?.ack, flight.seq)
    if (!outcome) return
    setFlight({ ...flight, ...outcome })
  }, [node.data, node.error, flight])

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
