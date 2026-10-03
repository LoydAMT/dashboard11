import { useId, useState } from 'react'
import { signIn, resetPassword } from '../auth'

/**
 * The only door into the app, and the whole page while it is showing: a
 * brand panel on one side, the form on the other, stacked on a phone.
 *
 * There is no sign-up link here, ever - accounts are created one at a time
 * in the Firebase console by whoever administers this dashboard. See the
 * note on the authorized/ allowlist in database.rules.json for why that
 * alone is not the real access boundary, but this form still shouldn't
 * invite someone to try registering.
 */
export function SignIn() {
  const id = useId()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [resetSent, setResetSent] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setResetSent(false)
    try {
      await signIn(email.trim(), password)
      // No further state to set on success - watchAuth in useAuth picks up
      // the new session and this form unmounts.
    } catch (err) {
      setError(readableAuthError(err))
    } finally {
      setBusy(false)
    }
  }

  const forgotPassword = async () => {
    const target = email.trim()
    if (!target) {
      setError('Enter your email above first, then use "Forgot your password?".')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await resetPassword(target)
      // Firebase does not reveal whether the address has an account - the
      // message is worded to be true either way, rather than confirming or
      // denying one exists.
      setResetSent(true)
    } catch (err) {
      setError(readableAuthError(err))
    } finally {
      setBusy(false)
    }
  }

  // A mistyped password with Caps Lock on looks exactly like a wrong one.
  const trackCaps = (e) => setCapsLock(Boolean(e.getModifierState?.('CapsLock')))

  return (
    <div className="login">
      <BrandPanel />

      <main className="login-main">
        <form className="login-form" onSubmit={submit}>
          <h1 className="login-title">Sign in</h1>
          <p className="login-sub">Welcome back. Sign in to see your systems.</p>

          <div className="login-field">
            <label className="login-label" htmlFor={`${id}-email`}>Email address</label>
            <input
              id={`${id}-email`}
              className="login-input"
              type="email"
              autoComplete="username"
              inputMode="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </div>

          <div className="login-field">
            <div className="login-label-row">
              <label className="login-label" htmlFor={`${id}-password`}>Password</label>
              <button
                type="button"
                className="login-reveal"
                onClick={() => setShowPassword((s) => !s)}
                aria-controls={`${id}-password`}
                aria-pressed={showPassword}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                <EyeIcon off={showPassword} />
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            <input
              id={`${id}-password`}
              className="login-input"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={trackCaps}
              onKeyUp={trackCaps}
              onBlur={() => setCapsLock(false)}
              disabled={busy}
            />
            <div className="login-field-foot">
              {capsLock ? <span className="login-caps">Caps Lock is on</span> : <span />}
              <button type="button" className="login-forgot" onClick={forgotPassword} disabled={busy}>
                Forgot your password?
              </button>
            </div>
          </div>

          {error && <p className="login-msg login-msg-error" role="alert">{error}</p>}
          {resetSent && !error && (
            <p className="login-msg login-msg-ok" role="status">
              If that email has an account, a reset link is on its way to it.
            </p>
          )}

          <button type="submit" className="login-submit" disabled={busy}>
            {busy && <span className="login-spinner" aria-hidden="true" />}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="login-foot">
            No account? Accounts are created by your administrator.
          </p>
        </form>
      </main>
    </div>
  )
}

/**
 * The left-hand panel. Everything drawn here is decoration and hidden from
 * assistive technology - there is no reading on it, real or pretend, because
 * a number on a login screen would be one nobody can trust.
 */
function BrandPanel() {
  return (
    <aside className="login-brand">
      <div className="login-art" aria-hidden="true">
        <div className="login-glow login-glow-a" />
        <div className="login-glow login-glow-b" />
        <div className="login-floor">
          {NODES.map(([x, y, d], i) => (
            <span key={i} className="login-node" style={{ '--x': x, '--y': y, animationDelay: `${d}s` }} />
          ))}
        </div>
        <svg className="login-wave" viewBox="0 0 600 120" preserveAspectRatio="none">
          <defs>
            <linearGradient id="login-wave-stroke" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="#38bdf8" stopOpacity="0" />
              <stop offset=".25" stopColor="#38bdf8" />
              <stop offset=".75" stopColor="#7c8cff" />
              <stop offset="1" stopColor="#7c8cff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path className="login-wave-base" d={WAVE} />
          <path className="login-wave-flow" d={WAVE} />
        </svg>
      </div>

      <div className="login-brand-top">
        <img className="login-logo" src="/favicon-48.png" alt="" aria-hidden="true" />
        <div className="login-wordmark">
          <span className="login-wordmark-name">INSTRUBYTE</span>
          <span className="login-wordmark-tag">Telemetry</span>
        </div>
      </div>

      <div className="login-brand-body">
        <span className="login-rule" aria-hidden="true" />
        <p className="login-eyebrow">Smart Monitoring &amp; Analytics Platform</p>
        <p className="login-headline">Every System.<br />Connected.<br />Monitored.</p>
        <p className="login-lede">
          A centralized platform for real-time monitoring, data acquisition,
          analysis, and automated alerts across industrial and utility systems.
        </p>
        <p className="login-points-label">Key capabilities</p>
        <ul className="login-points">
          <li><PointIcon kind="live" />Real-time data acquisition and visualization</li>
          <li><PointIcon kind="alert" />Intelligent alerts and event notifications</li>
          <li><PointIcon kind="trend" />Historical trends, reporting and analytics</li>
          <li><PointIcon kind="remote" />Remote equipment and process monitoring</li>
          <li><PointIcon kind="log" />Automated data logging and reporting</li>
        </ul>
      </div>

      <p className="login-brand-foot">© {new Date().getFullYear()} Instrubyte Telemetry</p>
    </aside>
  )
}

// Two and a half cycles of a sine across the panel - the shape of the
// supply these meters read, not a plot of anything.
const WAVE = (() => {
  const pts = []
  for (let x = 0; x <= 600; x += 6) {
    const y = 60 + 38 * Math.sin((x / 600) * Math.PI * 5)
    pts.push(`${x === 0 ? 'M' : 'L'}${x} ${y.toFixed(1)}`)
  }
  return pts.join(' ')
})()

// Meters on the floor grid: [column, row from the front, pulse delay s].
// Columns 7-14 are the ones under the panel at any desktop width.
const NODES = [
  [8, 1, 0], [11, 2, 1.2], [13, 1, 2.1], [9, 4, .6],
  [12, 5, 1.7], [10, 7, 2.6], [7, 3, .9], [14, 3, 3.1],
]

function EyeIcon({ off }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"
        stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      {off && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  )
}

function PointIcon({ kind }) {
  const paths = {
    live: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
    alert: <><path d="M6 17V11a6 6 0 1 1 12 0v6l1.5 2H4.5L6 17Z" /><path d="M10 21a2 2 0 0 0 4 0" /></>,
    // Axes with a rising line: history and analytics.
    trend: <><path d="M4 4v16h16" /><path d="M8 15l3.5-4 3 2.5L19 8" /></>,
    // A point with signal arcs either side: something monitored from afar.
    remote: (
      <>
        <circle cx="12" cy="12" r="1.8" />
        <path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6" />
        <path d="M15.8 8.2a5.4 5.4 0 0 1 0 7.6" />
        <path d="M5.3 5.3a9.5 9.5 0 0 0 0 13.4" />
        <path d="M18.7 5.3a9.5 9.5 0 0 1 0 13.4" />
      </>
    ),
    // A sheet with ruled lines: the logged record.
    log: (
      <>
        <path d="M7 3h7l4 4v14H7V3Z" />
        <path d="M14 3v4h4" />
        <path d="M10 12h5M10 16h5" />
      </>
    ),
  }
  return (
    <span className="login-point-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {paths[kind]}
      </svg>
    </span>
  )
}

/** Firebase's own messages name the SDK; these say what an operator can do about it. */
function readableAuthError(err) {
  const code = err?.code || ''
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'Email or password not recognised.'
  }
  if (code === 'auth/too-many-requests') {
    return 'Too many attempts - wait a few minutes before trying again.'
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Email/password sign-in is not enabled for this project yet.'
  }
  if (code === 'auth/invalid-email') {
    return 'That does not look like a valid email address.'
  }
  if (code === 'auth/network-request-failed') {
    return 'No connection to Firebase. Check the network and try again.'
  }
  return err?.message || 'Sign-in failed.'
}
