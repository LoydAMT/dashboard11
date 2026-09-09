// Sign-in strategy, kept behind one module so it can be swapped.
//
// Real accounts: email + password, created one at a time in the Firebase
// console (Authentication tab) by whoever administers this dashboard. There
// is no sign-up flow anywhere in this app, on purpose - see the note on
// AUTHORIZED_PATH in database.rules.json for why "no sign-up form" alone
// is not the actual security boundary.
//
// Nothing outside this module inspects how a user signed in - callers just
// get a Firebase User or null. Swapping to a different provider later is a
// change to this file alone.

import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth'
import { auth } from './firebase'

export function signIn(email, password) {
  return signInWithEmailAndPassword(auth, email, password)
}

export function signOutUser() {
  return signOut(auth)
}

/** Sends a reset link to an existing account's own address. Never creates one. */
export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email)
}

export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback)
}

/**
 * Whether this session is a real, non-anonymous sign-in.
 *
 * This is not the whole access decision - see App.jsx, which additionally
 * checks the authorized/{uid} allowlist read from the database before
 * treating a session as usable. That second check is the one that actually
 * keeps a self-registered account out; this one only rules out anonymous.
 * Kept as its own function anyway, because "is this identity real" and "is
 * this identity on the list" are different questions answered by different
 * data (the Firebase user object here; a database read there), and collapsing
 * them into one place would hide which failure is which.
 */
export function canControl(user) {
  return Boolean(user) && !user.isAnonymous
}
