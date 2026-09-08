// Firebase bootstrap. One app, one database handle, one auth handle.
//
// The web config below is not a secret. Anyone can read it out of the deployed
// bundle. What actually protects the data is database.rules.json, which grants
// read only to an authenticated user and denies every client write.

import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'
import { getAuth } from 'firebase/auth'

// Kept as env-var name -> SDK field so a missing value can be reported as the
// variable you edit, not as the internal key it maps to. Being told `apiKey` is
// missing sends you looking for something that appears nowhere in .env.local.
const FIELDS = {
  VITE_FIREBASE_API_KEY: 'apiKey',
  VITE_FIREBASE_AUTH_DOMAIN: 'authDomain',
  VITE_FIREBASE_PROJECT_ID: 'projectId',
  VITE_FIREBASE_APP_ID: 'appId',
  VITE_FIREBASE_DATABASE_URL: 'databaseURL',
}

const env = import.meta.env

const config = Object.fromEntries(
  Object.entries(FIELDS).map(([varName, field]) => [field, env[varName]]),
)

// Which variables are absent. The app reports these instead of failing
// obscurely — a blank screen on a plant-floor phone is indistinguishable from a
// dead plant, and someone will go looking for a fault that is not there.
export const missingConfig = Object.keys(FIELDS).filter((varName) => !env[varName])

// getDatabase() throws outright on a missing databaseURL, at import time. Left
// unguarded that kills the module before React mounts, so the very screen meant
// to explain the misconfiguration never renders. Build the handles only when
// there is something to build them from; nothing touches them on the path that
// shows the setup notice.
const configured = missingConfig.length === 0
const app = configured ? initializeApp(config) : null

export const db = configured ? getDatabase(app) : null
export const auth = configured ? getAuth(app) : null

// Which device node drives the live/stale badge.
export const DEVICE_ID = import.meta.env.VITE_DEVICE_ID || 'RHW01'
