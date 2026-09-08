import { RANGES } from '../lib/ranges'

export function RangePicker({ value, onChange }) {
  return (
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
  )
}
