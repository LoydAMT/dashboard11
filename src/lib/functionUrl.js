// Where a Cloud Function lives, derived rather than configured.
//
// Each endpoint used to need its own VITE_*_URL, set by hand in every
// environment - and they drift: VITE_ALERTS_API_URL was missing from both
// local env files, so the alert log would show "unavailable" on any build
// made from them. Every function here is deployed to one region of one
// project, so its address follows from the project id the app already
// needs to start at all. The Lua on the boxes reaches archiveRollups the
// same way.
//
// VITE_FUNCTIONS_BASE overrides the base (an emulator, say). A per-function
// variable, where one exists, still wins over both.

const REGION = 'asia-southeast1'

export function functionUrl(name) {
  const base = import.meta.env.VITE_FUNCTIONS_BASE
  if (base) return `${String(base).replace(/\/+$/, '')}/${name}`
  const project = import.meta.env.VITE_FIREBASE_PROJECT_ID
  return project ? `https://${REGION}-${project}.cloudfunctions.net/${name}` : null
}
