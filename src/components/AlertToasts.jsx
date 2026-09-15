const ICON = {
  'alarm-high': '▲',
  'alarm-low': '▼',
  'alarm-clear': '✓',
  disconnected: '⚠',
  reconnected: '✓',
  spike: '↕',
}

/**
 * Transient alerts, stacked newest-last. Each one self-dismisses (see
 * useAlertCenter's TOAST_LIFE_MS) but can be closed early - a critical one
 * (a disconnect, a limit breach) stays up long enough to actually be read
 * before it does either.
 *
 * `role="log"` + `aria-live="assertive"` rather than the banner's "polite":
 * these are events, not a standing status, and a screen-reader user should
 * hear about a new alarm as it happens rather than only on their next pause.
 */
export function AlertToasts({ toasts, onDismiss }) {
  if (!toasts.length) return null

  return (
    <div className="toast-stack" role="log" aria-live="assertive" aria-relevant="additions">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`}>
          <span className="toast-icon" aria-hidden="true">{ICON[t.kind] || '•'}</span>
          <span className="toast-message">{t.message}</span>
          <button
            type="button"
            className="toast-dismiss"
            aria-label="Dismiss"
            onClick={() => onDismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
