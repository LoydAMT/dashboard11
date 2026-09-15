// A second, longer-lived layer under useSeriesHistory's in-memory `store`:
// sessionStorage survives a page reload, which a plain useState does not.
// Scoped to sessionStorage rather than localStorage on purpose - cleared
// when the tab closes, so a shared plant-floor browser does not keep
// serving one shift's cached readings to the next indefinitely.
//
// Raw ranges are deliberately excluded (see MAX_ROWS below): a 3-day raw
// window can hold on the order of a quarter million rows (see
// useSeriesHistory's RAW_PAGE_SIZE comment), and sessionStorage's quota is
// shared across the whole origin - persisting one such series could starve
// every other cached slot, or throw outright. Skipping those and falling
// back to a normal REST backfill on reload is safer than either.

const PREFIX = 'rhw-hist:'
const MAX_ROWS = 20_000 // comfortably covers the largest rollup range (7d = 10,080 rows)

export function loadCachedRows(slot) {
  try {
    const raw = sessionStorage.getItem(PREFIX + slot)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((r) => r && typeof r.t === 'number')
  } catch {
    return null
  }
}

export function saveCachedRows(slot, rows) {
  if (rows.length > MAX_ROWS) return
  try {
    sessionStorage.setItem(PREFIX + slot, JSON.stringify(rows))
  } catch {
    // Quota exceeded, private browsing, or storage disabled - the
    // in-memory `store` this sits on top of still works for this page load.
  }
}
