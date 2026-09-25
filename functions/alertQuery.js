'use strict';

// Filtering and paging for the alert log.
//
// WHY FILTERS ARE APPLIED ON THE SERVER, NOT IN THE BROWSER
// The obvious build filters whatever page the browser already holds. That is
// quietly wrong: pick one tenant and you see that tenant's alerts FROM THE
// LAST 200 MALL-WIDE, not that tenant's history. A filter that looks
// complete and is not is worse than no filter, so the function keeps
// reading until it has a page of matches or has searched as far back as one
// request is allowed to go - and says which.
//
// WHY THE CURSOR IS A DOCUMENT, NOT A TIMESTAMP
// Paging used to continue from `ts < before`. Alerts share timestamps
// constantly: every tenant's minute rollup lands on the same minute, so six
// devices spiking together write six alerts at the identical ts, and one
// device can raise a Current and a Voltage alert in the same minute. When a
// page ended inside such a minute, `ts < before` skipped the rest of it for
// good. The cursor is now the last document read, and Firestore resumes
// strictly after it in its own total order (ts, then document path), so a
// shared timestamp can neither drop nor repeat an alert.

const MAX_LIST = 100;      // entries accepted per list parameter
const MAX_ITEM_LEN = 128;

/** "a,b,c" -> ['a','b','c'], bounded and de-duplicated; [] when absent. */
function list(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const out = [];
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (v && v.length <= MAX_ITEM_LEN && !out.includes(v)) out.push(v);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

function num(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Everything the caller can ask for, validated. Unknown keys are ignored. */
function parseFilters(q = {}) {
  const since = num(q.since);
  const until = num(q.until);
  return {
    devices: list(q.devices),
    kinds: list(q.kinds),
    tags: list(q.tags),
    since,
    // An inverted range is a mistake, not a request for nothing - drop the
    // upper bound rather than return an empty log that looks like a quiet site.
    until: until && since && until <= since ? null : until,
    limit: Math.min(500, Math.max(1, Number(q.limit) || 200)),
    cursor: typeof q.cursor === 'string' && q.cursor.length > 0 && q.cursor.length < 1024
      ? q.cursor
      : null,
  };
}

/**
 * Does one alert pass the filters that are NOT expressed in the query?
 *
 * The time range is in the query itself (a range on the field it is ordered
 * by needs no extra index). Device, kind and reading are checked here, which
 * keeps every combination of them working without an index per combination.
 */
function matches(alert, f) {
  if (!alert) return false;
  if (f.devices.length > 0 && !f.devices.includes(alert.device)) return false;
  if (f.kinds.length > 0 && !f.kinds.includes(alert.kind)) return false;
  // Device-level alerts (offline/online) carry no tag. When a reading filter
  // is active they are excluded: someone narrowing to "Voltage" is asking
  // about voltage, and a box going offline is not a voltage event.
  if (f.tags.length > 0 && !f.tags.includes(alert.tagKey)) return false;
  if (f.since && !(alert.ts >= f.since)) return false;
  if (f.until && !(alert.ts < f.until)) return false;
  return true;
}

/**
 * Read pages until there is a full page of matches, the log is exhausted,
 * or `maxScan` documents have been examined.
 *
 * @param fetchPage  async (afterDoc | null, n) => { docs: [...], exhausted }
 *                   where each doc is { path, ts, data, ref? } in log order
 * @param afterDoc   where to resume, or null for the newest
 *
 * Returns the matches plus the LAST DOCUMENT SCANNED - not the last one
 * matched - as the resume point. Resuming from the last match would re-read
 * every non-matching document after it on the next request.
 *
 * `partial` means the scan budget ran out before the page filled. The page
 * is still correct; it is just shorter than asked, and the caller should say
 * how far back it looked rather than imply that was everything.
 */
async function runFiltered({ fetchPage, afterDoc = null, filters, maxScan = 1500, batch = 300 }) {
  const out = [];
  let last = afterDoc;
  let scanned = 0;
  let exhausted = false;

  for (;;) {
    if (out.length >= filters.limit) break;   // page full
    if (scanned >= maxScan) break;            // budget spent

    const want = Math.min(batch, maxScan - scanned);
    const page = await fetchPage(last, want);
    const docs = page.docs || [];
    const endOfLog = Boolean(page.exhausted) || docs.length < want;

    let filledAt = -1;
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      scanned += 1;
      last = d;
      if (matches(d.data, filters)) {
        out.push({ id: d.id, ...d.data });
        // Stop AT the match that fills the page, not at the end of the
        // batch. The cursor must never sit beyond a match it did not
        // return, or the next page would silently skip it.
        if (out.length >= filters.limit) { filledAt = i; break; }
      }
    }

    if (filledAt >= 0) {
      // Full page. It is only the end of the log if nothing was left
      // unread behind the match that filled it.
      exhausted = endOfLog && filledAt === docs.length - 1;
      break;
    }
    if (endOfLog) { exhausted = true; break; }
  }

  const hasMore = !exhausted;
  return {
    alerts: out,
    last,
    scanned,
    hasMore,
    // The scan budget ran out before the page filled. What came back is
    // correct, just short - the caller should say how far back it looked
    // rather than imply that was everything.
    partial: hasMore && out.length < filters.limit,
    searchedTo: last && typeof last.ts === 'number' ? last.ts : null,
  };
}

module.exports = { parseFilters, matches, runFiltered, list };
