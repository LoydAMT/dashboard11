import { useEffect, useRef, useState } from 'react'
import { useVfdCommand } from '../hooks/useVfdCommand'
import { useNow } from '../hooks/useNow'
import { formatAgo, formatLocal } from '../lib/time'
import { POLL_MS, VFD_OFF, VFD_ON, pastFor, stateFor, verbFor } from '../lib/vfd'

// Said once in the panel and again in the dialog. It is the sort of thing that
// gets skimmed exactly when it matters, so it is not tucked into a tooltip.
const NOT_AN_ESTOP =
  'It is a normal command that waits for the RH-W to poll, and it can be ' +
  'ignored or fail. Use the physical E-stop to stop the machine in an emergency.'

// Nothing on this screen reads the drive. Everything it knows, it knows because
// the box said it acted - which is not the same claim, and the difference is
// invisible unless it is written down.
const NOT_A_READBACK =
  'Shows commands and their acknowledgements, not a readback from the drive.'

export function VfdControl({ deviceId, mayControl, authResolved }) {
  const { known, flight, busy, settled, send, dismiss, loading, error } =
    useVfdCommand(deviceId, mayControl)

  const [confirming, setConfirming] = useState(null)
  const dialogRef = useRef(null)
  const now = useNow(1000)

  // Native <dialog> rather than a hand-rolled overlay: it gives the focus trap,
  // the inert background and Escape-to-cancel for free, and on a control
  // surface those are correctness, not polish.
  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (confirming != null && !d.open) d.showModal()
    else if (confirming == null && d.open) d.close()
  }, [confirming])

  const status = describeFlight(flight, now)
  const disabled = !mayControl || busy

  return (
    <section className="panel vfd" aria-labelledby="vfd-heading">
      <div className="panel-head">
        <div>
          <div className="panel-title" id="vfd-heading">VFD control · {deviceId}</div>
          <div className="panel-sub">{NOT_A_READBACK}</div>
        </div>
      </div>

      <p className="vfd-warning" role="note">
        <strong>Not an emergency stop.</strong> {NOT_AN_ESTOP}
      </p>

      {!mayControl && (
        <p className="vfd-locked">
          {authResolved
            ? 'Sign in to command this device. The buttons stay disabled until then.'
            : 'Checking your session…'}
        </p>
      )}

      {error && (
        <p className="vfd-line vfd-bad">
          Cannot read the command node: {error.message || String(error)}. The
          buttons are still live, but nothing here can be confirmed.
        </p>
      )}

      <div className="vfd-buttons" role="group" aria-label="VFD command">
        <button
          type="button"
          className="vfd-btn vfd-start"
          disabled={disabled}
          aria-disabled={disabled}
          onClick={() => setConfirming(VFD_ON)}
        >
          Start
        </button>
        <button
          type="button"
          className="vfd-btn vfd-stop"
          disabled={disabled}
          aria-disabled={disabled}
          onClick={() => setConfirming(VFD_OFF)}
        >
          Stop
        </button>
      </div>

      {/* One live region for the whole exchange. Assertive because it reports
          what physical equipment did or did not do. */}
      <div className="vfd-status" role="status" aria-live="assertive">
        {status && (
          <div className={`vfd-line vfd-${status.tone}`}>
            <div className="vfd-line-title">{status.title}</div>
            <div className="vfd-line-detail">{status.detail}</div>
            {settled && (
              <button type="button" className="vfd-dismiss" onClick={dismiss}>
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>

      <p className="vfd-known">{describeKnown(known, now, loading, mayControl)}</p>

      <dialog
        ref={dialogRef}
        className="vfd-dialog"
        aria-labelledby="vfd-confirm-title"
        onCancel={() => setConfirming(null)}
        onClose={() => setConfirming(null)}
      >
        {confirming != null && (
          <ConfirmBody
            value={confirming}
            deviceId={deviceId}
            known={known}
            onCancel={() => setConfirming(null)}
            onConfirm={() => {
              const value = confirming
              setConfirming(null)
              send(value)
            }}
          />
        )}
      </dialog>
    </section>
  )
}

/**
 * The confirmation names the physical action, because "Are you sure?" tells an
 * operator nothing they did not already know and trains them to click through.
 */
function ConfirmBody({ value, deviceId, known, onCancel, onConfirm }) {
  const starting = value === VFD_ON
  const alreadyThere = known.state === 'confirmed' && known.value === value

  return (
    <div className="vfd-dialog-body">
      <h2 id="vfd-confirm-title">
        {starting ? 'This will start the VFD' : 'This will stop the VFD'}
      </h2>

      <p>
        {starting
          ? `Sending this command will start the variable frequency drive on ${deviceId}. Make sure the machine and everyone near it are clear before you continue.`
          : `Sending this command will stop the variable frequency drive on ${deviceId}. Anything the drive is running will coast or brake to a halt.`}
      </p>

      <p className="vfd-dialog-note">
        The RH-W checks for commands about every {Math.round(POLL_MS / 1000)}{' '}
        seconds, so this can take that long to take effect — and it may not take
        effect at all. {NOT_AN_ESTOP}
      </p>

      {alreadyThere && (
        <p className="vfd-dialog-note">
          The last confirmed command was already{' '}
          <strong>{stateFor(value)}</strong>. Sending this again is harmless but
          may not change anything.
        </p>
      )}

      <div className="vfd-dialog-actions">
        <button type="button" className="vfd-btn vfd-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={`vfd-btn ${starting ? 'vfd-start' : 'vfd-stop'}`}
          onClick={onConfirm}
          autoFocus
        >
          {verbFor(value)} the VFD
        </button>
      </div>
    </div>
  )
}

/** The in-flight line. Every branch says plainly what the drive has and has not done. */
function describeFlight(flight, now) {
  if (!flight) return null
  const { phase, value } = flight
  const verb = verbFor(value)

  if (phase === 'sending') {
    return {
      tone: 'pending',
      title: `Sending the ${verb.toLowerCase()} command…`,
      detail: 'Writing to the database. It has not reached the RH-W yet.',
    }
  }

  if (phase === 'pending') {
    const secs = Math.max(0, Math.round((now - flight.sentAt) / 1000))
    return {
      tone: 'pending',
      title: `Sent — waiting for the RH-W to pick it up (${secs}s)`,
      detail:
        `The box polls about every ${Math.round(POLL_MS / 1000)} seconds, so this ` +
        'is normal. Nothing has reached the VFD yet, and both buttons stay ' +
        'disabled until the box answers.',
    }
  }

  if (phase === 'ok') {
    return {
      tone: 'ok',
      title: `${pastFor(value)} — confirmed by the RH-W`,
      detail: flight.executedAt
        ? `Executed at ${formatLocal(flight.executedAt)}.`
        : 'The box acknowledged that it executed the command.',
    }
  }

  if (phase === 'stale') {
    return {
      tone: 'bad',
      title: 'Not executed — the command was already too old',
      detail:
        'The RH-W did not see this command until more than 30 seconds after it ' +
        'was issued, so it discarded it without touching the VFD. Nothing has ' +
        `been retried, because by now you may want something else. Press ${verb} ` +
        'again if that is still what you want.',
    }
  }

  if (phase === 'error') {
    return {
      tone: 'bad',
      title: 'The RH-W reported an error',
      detail:
        `The box received the command and could not carry it out${
          flight.unknownStatus ? ` (it replied "${flight.unknownStatus}")` : ''
        }. It is not known whether the drive changed state — check it before ` +
        'commanding again. Nothing has been retried.',
    }
  }

  if (phase === 'superseded') {
    return {
      tone: 'bad',
      title: 'Overtaken by a newer command',
      detail:
        `The RH-W acknowledged command #${flight.ackSeq} instead of yours ` +
        `(#${flight.seq}) — someone else may have pressed a button after you ` +
        'did. The drive is following that command, not yours.',
    }
  }

  if (phase === 'timeout') {
    return {
      tone: 'warn',
      title: 'No response from the RH-W',
      detail:
        'Nothing came back within 20 seconds. This does not mean the command ' +
        'failed: the box may not have polled yet, and it will still run anything ' +
        'it sees within 30 seconds of issue. Do not assume either outcome — ' +
        'watch the line below, or check the drive. Nothing has been retried.',
    }
  }

  if (phase === 'send-failed') {
    return {
      tone: 'bad',
      title: 'Could not send the command',
      detail: `${flight.detail} The command never reached the database, so the VFD was not touched.`,
    }
  }

  return null
}

/** The resting line, so someone returning to the page is not left guessing. */
function describeKnown(known, now, loading, mayControl) {
  if (!mayControl) return NOT_A_READBACK
  if (loading) return 'Reading the last command…'

  if (known.state === 'none') {
    return `No command has been sent to this device yet. ${NOT_A_READBACK}`
  }

  const when = known.at ?? known.issuedAt
  const stamp = when != null ? `${formatLocal(when)} (${formatAgo(now - when)})` : 'an unknown time'

  if (known.state === 'confirmed') {
    return `Last confirmed command: ${stateFor(known.value)}, executed ${stamp}. ${NOT_A_READBACK}`
  }

  if (known.state === 'rejected') {
    return (
      `Last command was ${verbFor(known.value).toLowerCase()}, issued ${stamp}, and the ` +
      `RH-W did not execute it (${known.status}). The drive was left as it was. ${NOT_A_READBACK}`
    )
  }

  return (
    `Last command was ${verbFor(known.value).toLowerCase()}, issued ${stamp}, and the RH-W ` +
    `has not acknowledged it. Whether it took effect is unknown. ${NOT_A_READBACK}`
  )
}
