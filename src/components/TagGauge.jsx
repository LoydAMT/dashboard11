/**
 * A tag's reading as a radial dial: a 250° sweep opening at the bottom, a
 * labelled scale, a fill showing how far along the reading sits, and alert
 * zones occupying the first and last 10% of the arc.
 *
 * WHY THE ZONES ARE A FIXED 10% rather than proportional to the real
 * numbers: a wall of these is read by shape, not by arithmetic. Fixing the
 * zones means "needle in the coloured part" carries the same meaning on
 * every card, whether the tag swings between 210 and 250 V or between 0 and
 * 10 A. The scale underneath adapts (lib/gauge.js); the picture does not.
 * A dial whose scale changes per card cannot be compared across a row, which
 * is the failure mode of every panel-meter widget that labels its threshold
 * in text and leaves it off the arc.
 *
 * The printed number is NEVER clamped, so a reading past the end of the
 * scale still shows its true value even though the needle has run out of arc.
 */

const CX = 50
const CY = 52
const R = 34           // arc radius
const STROKE = 8
const LABEL_R = R + 11 // scale numbers sit outside the band

// Sweep runs clockwise from lower-left to lower-right, leaving the bottom
// open for the reading. 0° points right, angles increase anticlockwise.
const A0 = 215
const A1 = -35

// A round cap extends a band by half a stroke past each end. Left
// uncorrected the 10% zones would paint as ~14% and the grey track would
// poke out past them, so every band is pulled in by what its cap adds back.
const SWEEP_LEN = (Math.abs(A0 - A1) * Math.PI / 180) * R
const CAP = (STROKE / 2) / SWEEP_LEN

// Advance width of one tabular digit at the label font size.
const CHAR_W = 6.5 * 0.55

// The viewBox is WIDER than the dial on purpose. The ends of the sweep point
// outward and down, so a label hung off them needs room beyond the dial's own
// box. Giving it a gutter lets every label sit at its true radial position;
// the alternative - squeezing labels inward to fit - drags them back onto the
// arc, which is worse than the dial simply being a little smaller.
const VB = { x: -11, y: 0, w: 122, h: 82 }

const rad = (deg) => (deg * Math.PI) / 180

/** Point at `pct` along the sweep, at `radius` from the centre. */
function pointAt(pct, radius = R) {
  const a = rad(A0 + (A1 - A0) * pct)
  return { x: CX + radius * Math.cos(a), y: CY - radius * Math.sin(a) }
}

/**
 * Path for the band that RENDERS between two fractions once its round cap is
 * added. Collapses to a dot rather than drawing backwards when a band is
 * shorter than its own caps.
 */
function arcPath(from, to, radius = R) {
  let f = from + CAP
  let t = to - CAP
  if (t <= f) { const mid = (from + to) / 2; f = mid; t = mid }
  const a = pointAt(f, radius)
  const b = pointAt(t, radius)
  const large = Math.abs(A1 - A0) * (t - f) > 180 ? 1 : 0
  return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${large} 1 ${b.x} ${b.y}`
}

/**
 * @param scale  result of gaugeScale(), never null
 * @param alarm  'high' | 'low' | 'ok' | 'none' | 'unknown'
 * @param stale  true when the reading is too old to trust
 */
export function TagGauge({ scale, alarm, stale, children, label }) {
  const { pct, loStop, hiStop, offScale, inferred, ticks } = scale

  // A stale reading gets the scale but no needle and no fill: the position
  // of an hours-old value is not a fact about now. The card's age line says
  // how old.
  const live = !stale && pct != null

  const cls = [
    'gauge',
    stale && 'gauge-stale',
    inferred && 'gauge-inferred',
    alarm === 'high' && 'gauge-alarm-high',
    alarm === 'low' && 'gauge-alarm-low',
  ].filter(Boolean).join(' ')

  const tip = live ? pointAt(pct, R + STROKE / 2 + 1) : null
  const hub = live ? pointAt(pct, 9) : null

  return (
    <div className={cls}>
      <svg viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`} className="gauge-svg"
           role="img" aria-label={label}>
        {/* Track, then fill, then zones: the zones are the most important
            thing on the dial, so nothing paints over them. */}
        <path className="gauge-track" d={arcPath(0, 1)} strokeWidth={STROKE} fill="none" />

        {live && pct > 0 && (
          <path className="gauge-fill" d={arcPath(0, pct)} strokeWidth={STROKE} fill="none" />
        )}

        {loStop != null && (
          <path className="gauge-zone gauge-zone-lo" d={arcPath(0, loStop)}
                strokeWidth={STROKE} fill="none" />
        )}
        {hiStop != null && (
          <path className="gauge-zone gauge-zone-hi" d={arcPath(hiStop, 1)}
                strokeWidth={STROKE} fill="none" />
        )}

        {/* Scale. Labels are anchored by which side of the dial they sit on,
            so they lean away from the arc instead of overlapping it. */}
        {ticks.map((t) => {
          const a = pointAt(t.pct, R - STROKE / 2 - 1)
          const b = pointAt(t.pct, R - STROKE / 2 - 4)
          const p = labelPos(t.pct, t.label)
          return (
            <g key={t.pct}>
              <line className="gauge-tick" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              <text className="gauge-tick-label" x={p.x} y={p.y} textAnchor={p.anchor}>
                {t.label}
              </text>
            </g>
          )
        })}

        {live && (
          <>
            <line className="gauge-needle" x1={hub.x} y1={hub.y} x2={tip.x} y2={tip.y}
                  strokeLinecap="round" />
            <circle className="gauge-hub" cx={CX} cy={CY} r={3.4} />
          </>
        )}

        {/* Arrow at the end a reading ran past, so "pinned to the end" is
            never mistaken for "sitting exactly on the threshold". */}
        {offScale && live && (
          <text className="gauge-offscale"
                x={offScale === 'high' ? 98 : 2} y={14}
                textAnchor={offScale === 'high' ? 'end' : 'start'}>
            {offScale === 'high' ? '▲' : '▼'}
          </text>
        )}
      </svg>

      <div className="gauge-readout">{children}</div>
    </div>
  )
}

/**
 * Where a scale label goes, nudged inward when hanging it off the sweep
 * would push it past the card edge. The tick mark stays on the arc, so the
 * label is still unambiguously attached to its position.
 */
function labelPos(pct, text) {
  const p = pointAt(pct, LABEL_R)
  const anchor = p.x < CX - 4 ? 'end' : p.x > CX + 4 ? 'start' : 'middle'
  // Clamped against the gutter rather than the dial, so this only ever fires
  // for a label longer than the scale is expected to produce - a safety net,
  // not the normal path.
  const w = String(text).length * CHAR_W
  const before = anchor === 'end' ? w : anchor === 'middle' ? w / 2 : 0
  const after = anchor === 'start' ? w : anchor === 'middle' ? w / 2 : 0
  const lo = VB.x + 1 + before
  const hi = VB.x + VB.w - 1 - after
  return { x: Math.min(Math.max(p.x, lo), hi), y: p.y + 2.4, anchor }
}
