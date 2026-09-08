import { formatValue, displayUnit } from '../lib/tags'

/**
 * Legend and visibility control in one.
 *
 * It lists every discovered tag, not only the drawn ones, so the same row that
 * identifies a trend is also the way to bring it back. A legend that showed
 * only what is already visible would leave no way to undo a hide except by
 * hunting for the card it came from.
 */
export function ChartLegend({ tags, visible, colors, onToggle, atCapacity, maxSeries }) {
  if (tags.length === 0) return null

  return (
    <div className="legend" role="group" aria-label="Trends shown on the chart">
      {tags.map((tag) => {
        const shown = visible.includes(tag.key)
        // A hidden tag can only be added back while there is room, but a shown
        // one can always be switched off — otherwise the cap could trap you at
        // four with no way down.
        const blocked = !shown && atCapacity
        const unit = displayUnit(tag)

        return (
          <button
            key={tag.key}
            type="button"
            className={`legend-item${shown ? ' legend-on' : ''}`}
            aria-pressed={shown}
            disabled={blocked}
            title={
              blocked
                ? `Showing the most this chart will overlay (${maxSeries}). Hide one first.`
                : shown ? `Hide ${tag.name}` : `Show ${tag.name}`
            }
            onClick={() => onToggle(tag.key)}
          >
            <span
              className="swatch"
              style={shown ? { background: colors[tag.key] } : undefined}
              aria-hidden="true"
            />
            <span className="legend-name">{tag.name}</span>
            {tag.hasReading && (
              <span className="legend-value">
                {formatValue(tag)}
                {unit && <span className="legend-unit">{unit}</span>}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
