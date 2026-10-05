import { useMemo, useState } from 'react'
import { useKwhHistory } from '../hooks/useKwhHistory'
import {
  KWH_RANGES, DEFAULT_KWH_RANGE, buildKwhRows, kwhTotal, formatKwhSpan,
  formatKwhAmount, kwhSoFar,
} from '../lib/kwh'
import { displayUnit } from '../lib/tags'
import { formatLocal } from '../lib/time'
import { offered } from '../lib/plans'

// Rows are already at most a few thousand even for "all time" (see
// lib/kwh.js) - nothing like the ten-thousand-row rollup tables elsewhere -
// so unlike DataTable there is no display cap here; every reading in the
// window is shown.

/**
 * kWh's own historical view. Separate from the chart/table panel above
 * (which every other tag shares) because that panel is built around minute
 * rollups and kWh has none, and because a meter's raw pushes call for
 * something that panel does not show at all: consumption between readings,
 * not the bare running total. See lib/kwh.js and hooks/useKwhHistory.js.
 *
 * On Standard: the recent week only, and no total across it - the package
 * guide gives Standard daily consumption, and weekly and monthly totals to
 * Premium. Every row still carries its own consumption.
 */
export function KwhHistory({ deviceId, tag, premium }) {
  const [rangeId, setRangeId] = useState(DEFAULT_KWH_RANGE.id)
  const ranges = offered(KWH_RANGES, premium)
  // Derived, so a plan change mid-session falls back by itself.
  const range = ranges.find((r) => r.id === rangeId) || DEFAULT_KWH_RANGE
  const { readings, since, loading, error } = useKwhHistory(deviceId, range, true)

  // Newest first, matching the convention the rollup/raw table uses (see
  // DataTable.jsx) - the question asked of a table like this is almost
  // always "what did it just do".
  const rows = useMemo(() => buildKwhRows(readings, since).reverse(), [readings, since])
  const total = useMemo(() => kwhTotal(rows), [rows])
  const anomalyCount = useMemo(() => rows.filter((r) => r.anomaly).length, [rows])
  const unit = displayUnit(tag)
  const fmt = formatKwhAmount

  // The day in progress: the live meter reading minus the newest stored
  // one. Stored readings are the daily 22:00 ones, so on a box that also
  // reads its meter through the day this is "used since 10 PM" - the same
  // figure the overview tile shows. Null on a box that only reads once a
  // day, where the live reading IS the newest stored one.
  const newest = rows[0] || null
  const soFar = newest
    ? kwhSoFar({ value: newest.value, readingTs: newest.t }, { v: tag.value, ts: tag.ts })
    : null

  return (
    <section className="panel" aria-labelledby="kwh-heading">
      <div className="panel-head">
        <div>
          <div className="panel-title" id="kwh-heading">Energy history · {tag.name}</div>
          <div className="panel-sub">
            Consumption between meter readings, read straight from every raw push - not
            the minute rollups the chart above uses.
          </div>
        </div>

        <div className="panel-controls">
          <div className="ranges" role="group" aria-label="Energy history range">
            {ranges.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`range-btn ${r.id === rangeId ? 'range-active' : ''}`}
                aria-pressed={r.id === rangeId}
                onClick={() => setRangeId(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? (
        <div className="placeholder">Could not read history: {error.message || String(error)}</div>
      ) : (
        <>
          <dl className="stats" aria-label={`${tag.name} consumption over ${range.label}`}>
            {soFar && (
              <div className="stat stat-live">
                <dt>used since {formatLocal(soFar.sinceTs)}</dt>
                <dd>
                  {soFar.reset ? 'meter reset?' : fmt(soFar.used)}
                  {!soFar.reset && unit && <span className="stat-unit">{unit}</span>}
                </dd>
              </div>
            )}
            {premium && (
              <div className="stat stat-live">
                <dt>total, {range.label.toLowerCase()}</dt>
                <dd>
                  {fmt(total)}
                  {unit && <span className="stat-unit">{unit}</span>}
                </dd>
              </div>
            )}
            <div className="stat">
              <dt>readings</dt>
              <dd>{rows.length.toLocaleString()}</dd>
            </div>
            {anomalyCount > 0 && (
              <div className="stat stat-anomaly">
                <dt>anomalies</dt>
                <dd>{anomalyCount}</dd>
              </div>
            )}
          </dl>

          <div className="table-scroll" tabIndex={0} role="region" aria-label="Energy readings">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col" className="col-time">Time</th>
                  <th scope="col">Reading</th>
                  <th scope="col">Consumption</th>
                  <th scope="col">Span</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.t} className={row.anomaly ? 'kwh-row-anomaly' : ''}>
                    <th scope="row" className="col-time">{formatLocal(row.t)}</th>
                    <td>{fmt(row.value)}{unit ? ` ${unit}` : ''}</td>
                    <td>
                      {row.deltaMs == null ? (
                        '—'
                      ) : row.anomaly ? (
                        <span
                          className="kwh-anomaly-badge"
                          title="This reading is lower than the one before it. A meter only counts up, so this means the counter was reset or the meter was replaced - not that consumption went negative."
                        >
                          meter reset?
                        </span>
                      ) : (
                        `${fmt(row.delta)}${unit ? ` ${unit}` : ''}`
                      )}
                    </td>
                    <td>{formatKwhSpan(row.deltaMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!rows.length && (
              <div className="placeholder">
                {loading ? 'Loading history…' : 'No readings in this window.'}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
