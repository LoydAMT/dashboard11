// Sign-in strategy, kept behind one function so it can be swapped.
//
// Today: anonymous auth. The rules require `auth != null`, so this exists to
// satisfy them, not to identify anyone.
//
// To move to real accounts later, change `ensureSignedIn` to run your chosen
// flow (signInWithEmailAndPassword, a popup provider, a custom token) and
// tighten the read rule in database.rules.json to match. Nothing else in the
// app inspects how the user was authenticated — it only waits for a user.

import { signInAnonymously, onAuthStateChanged } from 'firebase/auth'
import { auth } from './firebase'

export function ensureSignedIn() {
  return signInAnonymously(auth)
}

export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback)
}

/**
 * Whether this session may command the VFD.
 *
 * TESTING PHASE - READ BEFORE DEPLOYING ANYWHERE REAL.
 *
 * This currently returns true for any signed-in session, and the only sign-in
 * this app performs is anonymous. In practice that means anyone who can open
 * the dashboard link can start and stop the drive. That is a deliberate choice
 * for bench testing against the RH-W, not an oversight, and it is wrong for
 * production by design.
 *
 * When real sign-in lands, this becomes:
 *
 *     return Boolean(user) && !user.isAnonymous
 *
 * and the matching write condition in database.rules.json under commands/ has
 * to be tightened in the same commit - the rule is the actual gate, this
 * function only decides what to render. Changing one without the other either
 * shows buttons that cannot work or leaves the database open behind a hidden
 * button.
 */
export function canControl(user) {
  return Boolean(user)
}
