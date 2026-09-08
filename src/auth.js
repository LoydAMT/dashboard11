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
