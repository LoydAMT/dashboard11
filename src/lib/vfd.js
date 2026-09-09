// Commanding the VFD through the RH-W.
//
// No React and no Firebase in here, so the one thing that must not be got
// wrong - what counts as a confirmed command - can be read in a single place.
//
// The exchange is not request/response. The box polls this node about every
// ten seconds and writes an ack when it acts, so a button press is a message
// left for a machine that is not listening yet. Every rule below exists to stop
// the screen implying the drive moved at the moment the button did.

export const VFD_ON = 1
export const VFD_OFF = 6

/** The box's polling interval. A press can take this long to reach the drive. */
export const POLL_MS = 10_000

/**
 * Older than this when the box first sees it and the command is discarded as
 * stale_ignored - it never reaches the VFD. Ours to display, not to enforce;
 * the box decides.
 */
export const BOX_STALE_MS = 30_000

/**
 * How long we wait before admitting we have heard nothing. Two polling cycles.
 *
 * Deliberately shorter than BOX_STALE_MS, which means silence at this point is
 * genuinely ambiguous: the box may still poll at, say, 25s and execute the
 * command normally. Timing out must therefore report "no response", never
 * "did not happen" - see the copy in VfdControl.
 */
export const ACK_TIMEOUT_MS = 20_000

/** How long a confirmation stays up before the panel returns to its resting state. */
export const SUCCESS_HOLD_MS = 3_500

export const isCommandValue = (v) => v === VFD_ON || v === VFD_OFF

/**
 * Whether a Firebase error is the rules refusing this account, specifically -
 * as opposed to a network failure, a malformed write, or the box simply not
 * being there. The distinction matters most on a control surface: a denial
 * means "this account is not allowed to do this" and retrying changes
 * nothing, where every other failure here is honestly ambiguous about
 * whether trying again might work.
 */
export const isPermissionDenied = (error) =>
  error?.code === 'PERMISSION_DENIED' || /permission_denied/i.test(error?.message || '')

/** Imperative, for buttons and dialog titles. */
export const verbFor = (value) => (value === VFD_ON ? 'Start' : 'Stop')

/** Past tense, for reporting what the box confirmed. */
export const pastFor = (value) => (value === VFD_ON ? 'Started' : 'Stopped')

/** Resting-state noun, for "last confirmed: running". */
export const stateFor = (value) => (value === VFD_ON ? 'running' : 'stopped')

const numberOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * What the ack node says about the command we are waiting on.
 *
 * Confirmation is the narrow case, and only that case: status "ok" AND the seq
 * we sent. Anything else is not success - including an ack that reads "ok" for
 * some other command, which is precisely what a freshly attached listener sees
 * first, since the node still holds the previous command's ack.
 *
 * @param ack  commands/{device}/ack, as published by the box
 * @param sentSeq  the seq our own write committed
 * @returns null while nothing conclusive has arrived for our seq
 */
export function resolveAck(ack, sentSeq) {
  if (!ack || sentSeq == null) return null

  const ackSeq = numberOrNull(ack.seq)
  if (ackSeq == null) return null

  const executedAt = numberOrNull(ack.executedAt)

  if (ackSeq === sentSeq) {
    if (ack.status === 'ok') return { phase: 'ok', executedAt }
    if (ack.status === 'stale_ignored') return { phase: 'stale', executedAt }
    if (ack.status === 'error') return { phase: 'error', executedAt }
    // A status we do not recognise is not a success. Reporting it as a failure
    // with the raw string is the honest reading: something happened at the box
    // that this build does not understand, and the operator should look.
    return { phase: 'error', executedAt, unknownStatus: String(ack.status) }
  }

  // The box has already acted on something newer than ours. Someone else
  // pressed a button after we did, or a later press of our own overtook this
  // one. Our command did not decide the drive's state and never will, so
  // leaving the pending state running would be a lie of omission.
  if (ackSeq > sentSeq) return { phase: 'superseded', executedAt, ackSeq }

  // An older ack. The box has not reached ours yet.
  return null
}

/**
 * What may honestly be said about the drive when nothing is in flight.
 *
 * Note what this is not: a readback. Nothing here reads the VFD. It reads what
 * was commanded and whether the box said it acted. If the drive was stopped at
 * the panel, or tripped on its own, this still reports the last confirmed
 * command - so the UI has to carry that caveat rather than present it as the
 * machine's state.
 *
 * @returns {{ state: 'none'|'confirmed'|'rejected'|'unconfirmed', ... }}
 */
export function lastKnown(command) {
  if (!command || typeof command !== 'object') return { state: 'none' }

  const seq = numberOrNull(command.seq)
  const value = numberOrNull(command.value)
  const issuedAt = numberOrNull(command.issuedAt)
  if (seq == null || !isCommandValue(value)) return { state: 'none' }

  const ack = command.ack
  const ackSeq = numberOrNull(ack?.seq)

  // The ack has caught up with the newest command, so its verdict is the
  // current one.
  if (ackSeq === seq) {
    if (ack.status === 'ok') {
      return { state: 'confirmed', value, seq, issuedAt, at: numberOrNull(ack.executedAt) }
    }
    return {
      state: 'rejected',
      value,
      seq,
      issuedAt,
      at: numberOrNull(ack.executedAt),
      status: String(ack.status),
    }
  }

  // A command was issued that the box has not acked. Either it is still in
  // flight for whoever sent it, or nobody ever heard back. We do not know what
  // the drive did, and must not round that up to "commanded off/on".
  return { state: 'unconfirmed', value, seq, issuedAt }
}
