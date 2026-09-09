// Turning the raw RTDB nodes into something a card can render.
//
// Values reach the screen exactly as the device published them; nothing here
// rescales.
//
// The one rule this file exists to enforce: the tag list is discovered, never
// declared. Two tags today, forty next month — nothing here counts them.

/**
 * Union of every tag key seen under `latest/` and `tags/`.
 *
 * Both are included on purpose. A tag present in `tags/` but not yet in
 * `latest/` is a configured tag that has not reported — worth showing as
 * awaiting data rather than hiding. A tag in `latest/` but not `tags/` is a new
 * tag the logger registered before anyone gave it metadata; it still has a
 * value worth seeing.
 */
export function discoverTagKeys(latest, tags) {
  const keys = new Set([...Object.keys(latest || {}), ...Object.keys(tags || {})])
  return [...keys].sort((a, b) => {
    const an = sortKey(tags?.[a]?.name || a)
    const bn = sortKey(tags?.[b]?.name || b)
    const byName = an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' })
    // Tiebreak on the RTDB key so the order is total and never depends on
    // whatever order the two nodes happened to arrive in.
    return byName !== 0 ? byName : a.localeCompare(b)
  })
}

/**
 * Collation-stable form of a tag name.
 *
 * A tag whose metadata has arrived sorts by 'd/Test1'; one whose metadata has
 * not sorts by its sanitised key 'd_Test2'. Those separators collate
 * differently, so the two would interleave arbitrarily and — worse — the cards
 * would resequence the moment `tags/` caught up, sliding a card out from under
 * a thumb already moving toward it. Folding the separators the sanitiser
 * touches onto one character makes both forms of the same name sort alike.
 */
const sortKey = (name) => name.replace(/[./$#[\]]/g, '_')

/** Merge `latest/{key}` with `tags/{key}` into one object a card can consume. */
export function buildTag(key, latest, meta) {
  const dataType = meta?.dataType || 'num'
  const unit = meta?.unit ?? latest?.unit ?? null
  const value = latest?.value ?? null

  return {
    key,
    name: meta?.name || key,        // `name` holds the original 'd/Test1'
    description: meta?.description || null,
    unit,
    dataType,
    value,
    ts: latest?.ts ?? null,
    loLimit: numOrNull(meta?.loLimit),
    hiLimit: numOrNull(meta?.hiLimit),
    hasReading: latest != null && latest.value !== undefined,
    // The device's own configured push interval for *this* tag. Tags no
    // longer share one cadence - a fast tag and a once-a-day accumulator can
    // coexist - so staleness and history-source decisions key off this rather
    // than the device-wide interval useCadence measures. Absent on an older
    // or unconfigured tag, in which case callers fall back to their own
    // default rather than treat a missing field as "instant".
    intervalMs: numOrNull(meta?.intervalMs),
  }
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Where a value sits against its limits.
 * 'unknown' when there is no value or no limits — never silently "ok".
 */
export function limitState(tag) {
  if (tag.value == null || typeof tag.value !== 'number') return 'unknown'
  if (tag.loLimit == null && tag.hiLimit == null) return 'none'
  if (tag.hiLimit != null && tag.value > tag.hiLimit) return 'high'
  if (tag.loLimit != null && tag.value < tag.loLimit) return 'low'
  return 'ok'
}

/**
 * Display form of a value.
 *
 * Booleans arrive as REAL 1.0 / 0.0 because SQLite stores them that way. A tag
 * declared `bool` renders as a state, never as the number 1.
 */
export function formatValue(tag) {
  const { value, dataType } = tag
  if (value == null) return '—'

  if (dataType === 'bool') return Number(value) !== 0 ? 'ON' : 'OFF'
  if (dataType === 'text') return String(value)

  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value)

  // Keep magnitudes readable without inventing precision the sensor lacks.
  const abs = Math.abs(value)
  if (abs !== 0 && abs < 0.01) return value.toExponential(2)
  if (Number.isInteger(value)) return String(value)
  if (abs >= 1000) return value.toFixed(1)
  return value.toFixed(2)
}

/** Unit suffix. Booleans and text have no unit even if one is configured. */
export function displayUnit(tag) {
  if (tag.dataType === 'bool' || tag.dataType === 'text') return null
  return tag.unit || null
}
