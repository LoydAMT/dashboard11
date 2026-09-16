import { useMemo } from 'react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, LabelList,
} from 'recharts'
import { formatAxisTime, formatLocal } from '../lib/time'
import { formatValue, displayUnit } from '../lib/tags'
import { computeDomain, axisTickFormatter, axisTicks } from '../lib/domain'
import { flagChartAnomalies } from '../lib/anomalies'

const ANOMALY_COLOR = { 'breach-hi': 'var(--alarm-hi)', 'breach-lo': 'var(--alarm-lo)', spike: 'var(--stale)' }
const ANOMALY_TEXT = { 'breach-hi': 'above its high limit', 'breach-lo': 'below its low limit', spike: 'an unusual spike' }

/**
 * One-minute rollups for one or several tags over the selected window - or,
 * under a raw range, the individual pushes in a much shorter one. Both arrive
 * as the same {t, min, avg, max} row shape (see useSeriesHistory), so nothing
 * here has to know which one it is drawing except for the `raw` flag, used
 * only to word the empty state honestly.
 *
 * With a single tag the mean is the line and the min/max of everything folded
 * into each plotted point is the band behind it — without that band,
 * downsampling seven days into 600 points would quietly average away every
 * excursion, which is the one thing anyone opens a trend chart to find.
 *
 * With several tags the band is dropped: four translucent envelopes on one axis
 * is a smear. Identity then rests on the line colour, a legend, and a direct
 * label at the end of every line — three of the light-mode palette slots fall
 * below 3:1 against the panel surface, so colour alone is never asked to carry
 * it.
 */
export function HistoryChart({ tags, colors, data, rangeMs, raw, indexed, loading, error }) {
  const single = tags.length === 1 ? tags[0] : null
  const isBool = single?.dataType === 'bool'

  // Flags, not new data: built from the same `data` already being plotted
  // (see lib/anomalies.js). Only a lone series has a true per-bucket
  // envelope to test breaches against (lib/series.js); an overlay of several
  // falls back to each bucket's mean, which is why `hasEnvelope` only ever
  // applies to `single`. Computed even while loading/empty/erroring above so
  // this hook is never called conditionally.
  const anomalies = useMemo(() => {
    const out = {}
    for (const tag of tags) {
      out[tag.key] = flagChartAnomalies(data, tag, tag.key === single?.key)
    }
    return out
  }, [data, tags, single])
  const hasAnomalies = Object.values(anomalies).some((m) => m.size > 0)

  if (error) {
    return (
      <div className="chart-wrap">
        <div className="placeholder">Could not load history: {error.message}</div>
      </div>
    )
  }

  if (loading) {
    return <div className="chart-wrap"><div className="placeholder">Loading history…</div></div>
  }

  if (tags.length === 0) {
    return (
      <div className="chart-wrap">
        <div className="placeholder">
          No tags shown.
          <br />
          Pick one from the cards above, or from the legend below.
        </div>
      </div>
    )
  }

  const plotted = data.filter((row) => tags.some((t) => row[t.key] != null))
  if (plotted.length === 0) {
    return (
      <div className="chart-wrap">
        <div className="placeholder">
          No history in this range.
          <br />
          {raw
            ? 'A raw range only holds what was pushed inside this short window — try a wider one.'
            : 'Rollups appear a minute or so after the pusher starts writing.'}
        </div>
      </div>
    )
  }

  // Where each line ends, so the direct label lands on the last real point
  // rather than trailing off into a gap.
  const lastIndex = {}
  data.forEach((row, i) => {
    for (const tag of tags) if (row[tag.key] != null) lastIndex[tag.key] = i
  })

  const domain = computeDomain(data, tags, { isBool, indexed })
  const formatTick = axisTickFormatter(domain)
  const valueTicks = axisTicks(domain)

  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height="100%">
        {/* Right margin leaves room for the direct labels. */}
        <ComposedChart data={data} margin={{ top: 8, right: 68, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />

          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t) => formatAxisTime(t, rangeMs)}
            tick={{ fontSize: 11, fill: 'var(--text-faint)' }}
            stroke="var(--border)"
            minTickGap={44}
          />

          <YAxis
            domain={domain}
            tick={{ fontSize: 11, fill: 'var(--text-faint)' }}
            stroke="var(--border)"
            width={58}
            ticks={isBool && !indexed ? [0, 1] : indexed ? undefined : valueTicks}
            tickFormatter={
              indexed ? (v) => `${Math.round(v)}%`
                : isBool ? (v) => (v ? 'ON' : 'OFF')
                  : formatTick
            }
            allowDecimals={!isBool || indexed}
          />

          <Tooltip
            content={<ChartTooltip tags={tags} colors={colors} indexed={indexed} />}
            cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
            isAnimationActive={false}
          />

          {/* Limits belong to one tag's scale, so they are drawn only when that
              tag is alone on the axis and the axis is in real units. */}
          {single && !isBool && !indexed && single.hiLimit != null && (
            <ReferenceLine
              y={single.hiLimit}
              stroke="var(--alarm-hi)"
              strokeDasharray="5 4"
              label={{ value: `hi ${single.hiLimit}`, position: 'insideTopRight',
                       fontSize: 10, fill: 'var(--alarm-hi)' }}
            />
          )}
          {single && !isBool && !indexed && single.loLimit != null && (
            <ReferenceLine
              y={single.loLimit}
              stroke="var(--alarm-lo)"
              strokeDasharray="5 4"
              label={{ value: `lo ${single.loLimit}`, position: 'insideBottomRight',
                       fontSize: 10, fill: 'var(--alarm-lo)' }}
            />
          )}

          {single && !isBool && !indexed && (
            <Area
              dataKey="band"
              stroke="none"
              fill={colors[single.key]}
              fillOpacity={0.16}
              isAnimationActive={false}
              connectNulls={false}
              activeDot={false}
            />
          )}

          {tags.map((tag) => (
            <Line
              key={tag.key}
              dataKey={tag.key}
              name={tag.name}
              type={tag.dataType === 'bool' && !indexed ? 'stepAfter' : 'monotone'}
              stroke={colors[tag.key]}
              strokeWidth={2}
              dot={(props) => (
                <AnomalyDot {...props} kind={anomalies[tag.key]?.get(props.payload?.t)} />
              )}
              isAnimationActive={false}
              connectNulls={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
            >
              <LabelList
                dataKey={tag.key}
                content={(props) => (
                  <EndLabel
                    {...props}
                    show={props.index === lastIndex[tag.key]}
                    text={shortName(tag.name)}
                    fill={colors[tag.key]}
                  />
                )}
              />
            </Line>
          ))}
        </ComposedChart>
      </ResponsiveContainer>

      {hasAnomalies && (
        <div className="chart-note chart-anomaly-note">
          <span className="anomaly-dot anomaly-dot-breach-hi" aria-hidden="true" /> above/below limit
          {' · '}
          <span className="anomaly-dot anomaly-dot-spike" aria-hidden="true" /> unusual spike
        </div>
      )}
    </div>
  )
}

/**
 * A marked point, drawn only where `kind` says something is actually wrong -
 * every ordinary point still has `dot={false}`'s effect (nothing drawn), so a
 * healthy trend looks exactly as clean as it always did.
 */
function AnomalyDot({ cx, cy, kind }) {
  if (!kind || cx == null || cy == null) return null
  return (
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill={ANOMALY_COLOR[kind]}
      stroke="var(--surface)"
      strokeWidth={1.5}
      aria-label={ANOMALY_TEXT[kind]}
    />
  )
}

/**
 * The name of the series, once, at the end of its line.
 *
 * This is the secondary encoding the palette's light-mode contrast warning
 * requires: three slots sit under 3:1 on a white panel, and a reader who cannot
 * separate two hues can still read which line is which.
 */
function EndLabel({ show, x, y, text, fill }) {
  if (!show || x == null || y == null) return null
  return (
    <text
      x={x + 7}
      y={y}
      dy={4}
      fill={fill}
      fontSize={11}
      fontWeight={600}
      className="series-label"
    >
      {text}
    </text>
  )
}

const shortName = (name) => (name.length > 11 ? `${name.slice(0, 10)}…` : name)

function ChartTooltip({ active, payload, label, tags, colors, indexed }) {
  if (!active || !payload?.length) return null

  const row = payload[0].payload
  const shown = tags.filter((t) => row?.raw?.[t.key] != null)
  if (shown.length === 0) return null

  return (
    <div className="tooltip">
      <div className="tooltip-time">{formatLocal(label)}</div>

      {shown.map((tag) => {
        // Always the real reading, never the index — the axis may be showing
        // percentages, but the number a reader writes down must be the value.
        const actual = row.raw[tag.key]
        const unit = displayUnit(tag)

        return (
          <div className="tooltip-row" key={tag.key}>
            <span className="tooltip-label">
              <span className="swatch" style={{ background: colors[tag.key] }} aria-hidden="true" />
              {tag.name}
            </span>
            <span className="tooltip-value">
              {formatValue({ value: actual, dataType: tag.dataType, key: tag.key })}
              {unit ? ` ${unit}` : ''}
            </span>
          </div>
        )
      })}

      {/* The envelope is only meaningful for a lone series, which is the only
          case where it is drawn. */}
      {shown.length === 1 && row.min != null && row.max != null && row.max !== row.min && (
        <div className="tooltip-spread">
          min {round(row.min)} · max {round(row.max)}
        </div>
      )}

      {indexed && (
        <div className="tooltip-spread">Axis shows each trend as % of its own range.</div>
      )}
    </div>
  )
}

const round = (v) => (Number.isInteger(v) ? v : Number(v.toFixed(3)))
