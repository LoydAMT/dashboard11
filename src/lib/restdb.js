// A one-shot RTDB read over plain HTTPS instead of the SDK's persistent
// WebSocket. The two transports differ for exactly this case: the REST
// endpoint honours ordinary HTTP content negotiation, so a browser's
// automatic `Accept-Encoding: gzip` gets a compressed response back for
// free, which the SDK's realtime connection has no equivalent of for a
// single bulk read - and repetitive numeric/timestamp JSON like a history
// dump compresses hard.
//
// Used only for one-shot historical backfills (see useSeriesHistory.js).
// The live tail stays on the SDK's onValue: REST has no push mechanism, and
// polling it on an interval would cost more bandwidth than this saves, not
// less.
//
// RTDB's REST API authenticates a user's read via an `auth=<ID token>`
// query parameter, not an Authorization header - unlike Firestore's REST
// API, this is the only mechanism this particular product supports. That
// means the token sits in the URL for the lifetime of the request (visible
// in browser history and any access log in front of the database host);
// tokens expire in about an hour, which bounds the exposure but does not
// remove it.
import { auth } from '../firebase'

export async function fetchRtdbRest(path, params = {}) {
  const dbUrl = import.meta.env.VITE_FIREBASE_DATABASE_URL
  if (!dbUrl) throw new Error('VITE_FIREBASE_DATABASE_URL is not configured')
  if (!auth?.currentUser) throw new Error('REST read attempted with no signed-in user')

  // Not force-refreshed: the SDK already keeps this token fresh in the
  // background (renewing minutes before it actually expires), so this is
  // normally a cached read, not a network round trip - fetched per page of
  // a paginated backfill so a token that expires mid-backfill still gets a
  // valid one for whatever page is next, rather than one token reused for
  // every page of a fetch that might span several seconds.
  const token = await auth.currentUser.getIdToken()

  const url = new URL(`${dbUrl.replace(/\/+$/, '')}/${path}.json`)
  url.searchParams.set('auth', token)
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value))
  }

  const res = await fetch(url.toString())
  if (!res.ok) {
    throw new Error(`RTDB REST read failed: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

/** RTDB REST query values are JSON-encoded, so a string key needs its own literal quotes. */
export const quoted = (v) => `"${v}"`
