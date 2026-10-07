/**
 * The pop-up shown while live readings are paused on an unattended tab.
 *
 * A click (or touch, or key) ANYWHERE on it resumes - the whole backdrop is
 * the target, and it consumes the click so that resuming never also opens
 * whatever tile sat underneath. Alarms are not paused, and it says so, so
 * nobody mistakes a paused wall for a dead one.
 */
export function PausedNotice({ onResume }) {
  return (
    <div
      className="paused-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="paused-title"
      onClick={(e) => { e.stopPropagation(); onResume() }}
    >
      <div className="paused-card">
        <h2 id="paused-title">Live readings paused</h2>
        <p>
          Nothing was touched on this page for 5 minutes, so the moving
          readings were paused to save data. Alarms, alerts and offline
          status are still up to date.
        </p>
        <p className="paused-cta">Click anywhere to continue.</p>
      </div>
    </div>
  )
}
