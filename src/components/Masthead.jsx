import { ThemeToggle } from './ThemeToggle'
import { AlertBell } from './AlertBell'

/**
 * The header of every signed-in page: the dashboard, the device picker, a
 * mall's pages, and /naming.
 *
 * ONE component so the pages cannot drift apart again. The theme switch and
 * Sign out belong to the ACCOUNT, so they are shown wherever someone is
 * signed in - they used to wait for a device to be chosen, which left the
 * picker and the mall pages with no way to sign out. What belongs to a
 * DEVICE (its name, its alert bell) is shown only while that device is the
 * thing on screen.
 */
export function Masthead({
  tagline = 'Telemetry',
  signedIn = false, email, onSignOut, theme, onThemeChange,
  deviceName, periodMs,
  canSwitchDevice, onSwitchDevice,
  // Null hides the bell: there is no alert log without a device on screen.
  alertLog = null, onClearAlerts, onOpenHistory, nowMs,
  // { href, label } - the way across to the other half of the app.
  link = null,
  partners = [],
}) {
  return (
    <header className="masthead">
      <div className="masthead-brand">
        {/* Decorative: the wordmark beside it already names the company, so a
            screen reader gaining nothing from "image" would only add noise. */}
        <img className="masthead-logo" src="/favicon-48.png" alt="" aria-hidden="true" />
        <div className="masthead-text">
          <h1>INSTRUBYTE</h1>
          <span className="masthead-tagline">{tagline}</span>
        </div>
        {/* The client's own marks, for the device on screen (lib/brands.js).
            Real alt text here: unlike the Instrubyte mark, nothing else on
            the page names these organisations. */}
        {partners.length > 0 && (
          <div className="masthead-partners">
            {partners.map((p) => (
              <img
                key={p.src}
                className={`masthead-partner${p.bare ? ' masthead-partner-bare' : ''}`}
                src={p.src}
                alt={p.alt}
              />
            ))}
          </div>
        )}
      </div>
      <div className="masthead-right">
        {deviceName && (
          <span className="device">
            {deviceName}
            {periodMs ? ` · every ${formatInterval(periodMs)}` : ''}
          </span>
        )}
        {canSwitchDevice && (
          <button type="button" className="switch-btn" onClick={onSwitchDevice}>
            Switch device
          </button>
        )}
        {signedIn && link && <a className="switch-btn masthead-link" href={link.href}>{link.label}</a>}
        {signedIn && alertLog && (
          <AlertBell
            log={alertLog}
            onClear={onClearAlerts}
            nowMs={nowMs}
            onOpenHistory={onOpenHistory}
          />
        )}
        {signedIn && <ThemeToggle theme={theme} onChange={onThemeChange} />}
        {signedIn && (
          <button type="button" className="signout-btn" onClick={onSignOut} title={email || undefined}>
            Sign out
          </button>
        )}
      </div>
    </header>
  )
}

export const formatInterval = (ms) =>
  ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
