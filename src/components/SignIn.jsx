import { useState } from 'react'
import { signIn, resetPassword } from '../auth'

/**
 * The only door into the app. There is no sign-up link here, ever - accounts
 * are created one at a time in the Firebase console by whoever administers
 * this dashboard. See the note on the authorized/ allowlist in
 * database.rules.json for why that alone is not the real access boundary,
 * but this form still shouldn't invite someone to try registering.
 */
export function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
      setError('Enter your email above first, then use "Forgot password?".')
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

  return (
    <div className="signin">
      <form className="signin-form" onSubmit={submit}>
        <h2>Sign in</h2>
        <p className="signin-sub">
          Accounts are created by an administrator - there is no self sign-up.
        </p>

        <label className="signin-field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="signin-field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>

        {error && <p className="signin-error" role="alert">{error}</p>}
        {resetSent && !error && (
          <p className="signin-hint">
            If that email has an account, a reset link is on its way to it.
          </p>
        )}

        <button type="submit" className="signin-submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <button type="button" className="signin-forgot" onClick={forgotPassword} disabled={busy}>
          Forgot password?
        </button>
      </form>
    </div>
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
