import { formatValue, displayUnit, limitState } from '../lib/tags'
import { formatAgo } from '../lib/time'

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
export function TagCard({ tag, stale, shown, color, blocked, maxSeries, onSelect, nowMs }) {
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
    alarm === 'high' ? 'above high limit' : alarm === 'low' ? 'below low limit' : '',
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

      {alarm === 'high' && <div className="card-flag">Above high limit</div>}
      {alarm === 'low' && <div className="card-flag">Below low limit</div>}

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
