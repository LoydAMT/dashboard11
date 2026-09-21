import { formatValue, displayUnit, limitState } from '../lib/tags'
import { formatAgo } from '../lib/time'

/** "1h 4m", "6m", never "0m" - a just-started episode reads as "just now" instead. */
function formatDuration(ms) {
  if (!ms || ms < 30_000) return 'just now'
  const totalMin = Math.round(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/**
 * One tag. The card carries its own freshness, because the page-level banner
 * says whether the *link* is healthy and this says whether *this reading* is.
 * A tag can go quiet while the rest of the plant reports normally.
 *
 * Pressing it adds or removes the tag's trend from the chart. The pressed state
 * is marked three ways — the accent border, a colour bar matching the line, and
 * `aria-pressed` — because on the chart the tag is identified by colour, and a
 * colour bar alone would leave a colourblind reader guessing which card belongs
 * to which line.
 */
export function TagCard({ tag, stale, shown, color, blocked, maxSeries, onSelect, nowMs, session }) {
  const alarm = stale ? 'unknown' : limitState(tag)
  const unit = displayUnit(tag)
  const age = tag.ts != null ? nowMs - tag.ts : null

  const classes = [
    'card',
    shown && 'card-shown',
    stale && 'card-stale',
    alarm === 'high' && 'card-alarm-high',
    alarm === 'low' && 'card-alarm-low',
  ].filter(Boolean).join(' ')

  const label = [
    tag.name,
    tag.hasReading ? formatValue(tag) : 'no reading',
    unit || '',
    stale ? 'stale' : '',
    alarm === 'high' ? 'above alert threshold' : alarm === 'low' ? 'below alert threshold' : '',
    shown ? 'shown on chart' : 'hidden from chart',
  ].filter(Boolean).join(', ')

  return (
    <button
      type="button"
      className={classes}
      onClick={() => onSelect(tag.key)}
      aria-pressed={shown}
      aria-label={label}
      disabled={blocked}
      title={
        blocked
          ? `Showing the most this chart will overlay (${maxSeries}). Hide one first.`
          : shown ? `Hide ${tag.name} from the chart` : `Show ${tag.name} on the chart`
      }
    >
      {/* Ties the card to its line. Decorative: the pressed state is already
          carried by aria-pressed and by the border. */}
      <span
        className="card-stripe"
        style={shown ? { background: color } : undefined}
        aria-hidden="true"
      />

      <div className="card-head">
        <span className="card-name">{tag.name}</span>
      </div>

      <div className="card-value">
        {tag.dataType === 'bool' && tag.hasReading ? (
          <span className={`state-pill ${Number(tag.value) !== 0 ? 'state-on' : 'state-off'}`}>
            {formatValue(tag)}
          </span>
        ) : (
          <>
            <span className="card-number">{tag.hasReading ? formatValue(tag) : '—'}</span>
            {unit && <span className="card-unit">{unit}</span>}
          </>
        )}
      </div>

      {alarm === 'high' && <div className="card-flag">Above alert threshold</div>}
      {alarm === 'low' && <div className="card-flag">Below alert threshold</div>}

      {/* Session-only, not "today" - a real day's tally would mean fetching a
          day of this tag's history just to caption a card, which is the exact
          re-download-on-every-toggle cost this dashboard otherwise goes out
          of its way to avoid (see useSeriesHistory). This counts only what
          has happened while this dashboard has been open. */}
      {session && (session.episodes > 0) && (
        <div className="card-alarm-meta">
          {session.activeSince != null
            ? `In alarm ${formatDuration(nowMs - session.activeSince)}`
            : `Cleared · ${formatDuration(session.closedMs)} total`}
          {session.episodes > 1 && ` · ${session.episodes}× this session`}
        </div>
      )}

      {alarm === 'ok' && (tag.loLimit != null || tag.hiLimit != null) && (
        <div className="card-limits">
          {tag.loLimit != null ? tag.loLimit : '−∞'} to {tag.hiLimit != null ? tag.hiLimit : '∞'}
        </div>
      )}

      <div className="card-age">
        {tag.ts == null
          ? 'never reported'
          : stale
            ? `last updated ${formatAgo(age)}`
            : formatAgo(age)}
      </div>
    </button>
  )
}
