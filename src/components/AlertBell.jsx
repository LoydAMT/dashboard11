import { useState } from 'react'
import { formatLocal, formatAgo } from '../lib/time'

/**
 * Everything useAlertCenter has recorded for this device, in one place a
 * toast that already faded cannot take with it. Read-only except for
 * "Clear" - the log lives in this browser's localStorage (see lib/alerts.js),
 * not in Firebase, so clearing it here has no effect on anyone else's view.
 */
export function AlertBell({ log, onClear, nowMs }) {
  const [open, setOpen] = useState(false)
  const [seenAt, setSeenAt] = useState(0)
  const unread = log.filter((e) => e.ts > seenAt).length

  const toggle = () => {
    setOpen((o) => {
      if (!o) setSeenAt(Date.now())
      return !o
    })
  }

  return (
    <div className="alert-bell-wrap">
      <button
        type="button"
        className="bell-btn"
        onClick={toggle}
        aria-expanded={open}
        aria-label={`Alert history${unread ? `, ${unread} unread` : ''}`}
        title="Alert history"
      >
        <BellIcon />
        {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <div className="alert-panel" role="dialog" aria-label="Alert history">
          <div className="alert-panel-head">
            <span>Alert history</span>
            <button type="button" className="alert-clear" onClick={onClear} disabled={!log.length}>
              Clear
            </button>
          </div>
          {log.length === 0 ? (
            <div className="alert-panel-empty">Nothing recorded yet.</div>
          ) : (
            <ul className="alert-panel-list">
              {[...log].reverse().map((e) => (
                <li key={e.id} className={`alert-row alert-row-${e.level}`}>
                  <span className="alert-row-message">{e.message}</span>
                  <span className="alert-row-time" title={formatLocal(e.ts)}>
                    {formatAgo(nowMs - e.ts)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function BellIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 17V11a6 6 0 1 1 12 0v6l1.5 2.2a.6.6 0 0 1-.5.8H5a.6.6 0 0 1-.5-.8L6 17Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M10 21a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
