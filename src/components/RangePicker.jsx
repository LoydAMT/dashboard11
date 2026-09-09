import { RANGES, RAW_RANGES } from '../lib/ranges'

/**
 * Two separate groups, not nine buttons in one row. The rollup ranges answer
 * "how has this trended"; the raw ones answer "what did it actually just
 * push" - different enough questions that picking one from each group by
 * label alone, with no visual break between them, would read as one
 * over-long list rather than two distinct choices.
 */
export function RangePicker({ value, onChange }) {
  return (
    <>
      <div className="ranges" role="group" aria-label="Chart time range">
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`range-btn ${r.id === value ? 'range-active' : ''}`}
            aria-pressed={r.id === value}
            onClick={() => onChange(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="ranges ranges-raw" role="group" aria-label="Recent raw readings, unaggregated">
        <span className="ranges-raw-label">Raw</span>
        {RAW_RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`range-btn ${r.id === value ? 'range-active' : ''}`}
            aria-pressed={r.id === value}
            onClick={() => onChange(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>
    </>
  )
}
