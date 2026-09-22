/**
 * A tag's reading drawn as a 180° arc, with the alert zones occupying the
 * first and last 10% of the sweep.
 *
 * WHY THE ZONES ARE A FIXED SIZE rather than proportional to the real
 * numbers: a wall of cards is read by shape, not by arithmetic. Fixing the
 * zones at 10% means "needle in the coloured part" carries the same meaning
 * on every card regardless of whether the tag swings between 210 and 250 or
 * between 0 and 10. The scale underneath does the adapting (see
 * lib/gauge.js); the picture stays constant.
 *
 * The number is printed inside the arc and is NEVER clamped, so a reading
 * far off the scale still shows its true value even though the needle has
 * run out of arc to travel along.
 */

const R = 42          // arc radius in viewBox units
const CX = 50
const CY = 50
const STROKE = 9

/** Point on the arc at `pct` (0 = left end, 1 = right end). */
function pointAt(pct, radius = R) {
  const angle = Math.PI * (1 - pct)       // pi -> 0 sweeping left to right
  return { x: CX + radius * Math.cos(angle), y: CY - radius * Math.sin(angle) }
}

/** SVG path for the arc segment between two fractions. */
function arcPath(from, to, radius = R) {
  const a = pointAt(from, radius)
  const b = pointAt(to, radius)
  const large = to - from > 0.5 ? 1 : 0
  return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${large} 1 ${b.x} ${b.y}`
}

/**
 * @param scale   result of gaugeScale(), never null
 * @param alarm   'high' | 'low' | 'ok' | 'none' | 'unknown'
 * @param stale   true when the reading is too old to trust
 */
export function TagGauge({ scale, alarm, stale, children, label }) {
  const { pct, loStop, hiStop, offScale, inferred } = scale

  // A stale reading gets the scale but no needle: showing a needle would
  // assert a present position for a value that may be hours old. The card's
  // age line underneath says how old.
  const showNeedle = !stale && pct != null

  const cls = [
    'gauge',
    stale && 'gauge-stale',
    inferred && 'gauge-inferred',
    alarm === 'high' && 'gauge-alarm-high',
    alarm === 'low' && 'gauge-alarm-low',
  ].filter(Boolean).join(' ')

  const needle = showNeedle ? pointAt(pct, R + STROKE / 2 - 1) : null
  const inner = showNeedle ? pointAt(pct, R - STROKE / 2 - 4) : null

  return (
    <div className={cls}>
      <svg
        viewBox="0 0 100 58"
        className="gauge-svg"
        role="img"
        aria-label={label}
        preserveAspectRatio="xMidYMax meet"
      >
        {/* Normal band first, then the zones painted over its ends, so the
            joins are covered by the zone caps rather than leaving a seam. */}
        <path className="gauge-track" d={arcPath(0, 1)} strokeWidth={STROKE} fill="none" />

        {loStop != null && (
          <path className="gauge-zone gauge-zone-lo" d={arcPath(0, loStop)}
                strokeWidth={STROKE} fill="none" />
        )}
        {hiStop != null && (
          <path className="gauge-zone gauge-zone-hi" d={arcPath(hiStop, 1)}
                strokeWidth={STROKE} fill="none" />
        )}

        {/* Tick at each zone edge - the arc alone leaves the boundary a
            little ambiguous at small sizes. */}
        {loStop != null && <line className="gauge-tick" {...tick(loStop)} />}
        {hiStop != null && <line className="gauge-tick" {...tick(hiStop)} />}

        {needle && (
          <line
            className="gauge-needle"
            x1={inner.x} y1={inner.y} x2={needle.x} y2={needle.y}
            strokeLinecap="round"
          />
        )}

        {/* Arrow at the end the reading ran past, so "pinned to the end"
            cannot be misread as "sitting exactly at the limit". */}
        {offScale && !stale && (
          <text
            className="gauge-offscale"
            x={offScale === 'high' ? 96 : 4}
            y={54}
            textAnchor={offScale === 'high' ? 'end' : 'start'}
          >
            {offScale === 'high' ? '▸' : '◂'}
          </text>
        )}
      </svg>

      <div className="gauge-readout">{children}</div>
    </div>
  )
}

function tick(pct) {
  const a = pointAt(pct, R - STROKE / 2)
  const b = pointAt(pct, R + STROKE / 2)
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
}
