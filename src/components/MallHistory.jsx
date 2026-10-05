import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRtdbValue } from '../hooks/useRtdbValue'
import { useSeriesHistory } from '../hooks/useSeriesHistory'
import { useKwhHistory } from '../hooks/useKwhHistory'
import { useNow } from '../hooks/useNow'
import { RANGES, DEFAULT_RANGE } from '../lib/ranges'
import { KWH_RANGES, DEFAULT_KWH_RANGE } from '../lib/kwh'
import { offered } from '../lib/plans'
import { buildTag } from '../lib/tags'
import { mergeSeries } from '../lib/series'
import { buildTable } from '../lib/table'
import { colorForIndex, MAX_SERIES } from '../lib/palette'
import { DAY } from '../lib/time'
import {
  isEnergy, measurementKeys, meterTag, defaultShown, toggleShown, withoutNow,
  buildEnergyTable, energyChartRows, ALL_METERS_KEY,
} from '../lib/mallHistory'
import { DataTable } from './DataTable'
import { ChartLegend } from './ChartLegend'

// The same lazy chunk the single-meter dashboard loads, so opening a meter
// after this page (or the other way round) does not fetch the chart twice.
const HistoryChart = lazy(() =>
  import('./HistoryChart').then((m) => ({ default: m.HistoryChart })),
)

const EMPTY = []
const EMPTY_TABLE = { columns: [], groups: [], rows: [] }

/**
 * Every meter in a company on one chart and in one table, with the table's
 * Excel and CSV export.
 *
 * One READING at a time - Current, Voltage, the meter - across all the
 * meters that report it, which is the comparison a landlord is after; the
 * single-meter dashboard is still where several readings of one meter are
 * laid over each other.
 *
 * WHAT IT COSTS. The wall above is drawn from one subscription for the whole
 * company. History has no such projection, so this panel reads each meter's
 * own - but only what is on screen: the chart reads the handful of meters it
 * draws (the chart's cap, however large the mall), and every meter is read
 * only once the table is opened, because a table or an export that left
 * meters out would be the wrong answer to "show me all of them".
 */
export const MallHistory = memo(function MallHistory({ companyId, tenants, premium }) {
  // By name, not by the wall's "needs attention" order: that one reshuffles
  // whenever an alarm changes, and the columns of a table someone is reading
  // must not trade places under them.
  const ordered = useMemo(
    // Numeric, so "Unit 9" comes before "Unit 10".
    () => [...tenants].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })
      || a.id.localeCompare(b.id)),
    [tenants],
  )

  const measures = useMemo(() => measurementKeys(tenants), [tenants])
  const [pickedMeasure, setPickedMeasure] = useState(null)
  // Derived, so a reading that stops being reported falls back by itself.
  const measure = measures.includes(pickedMeasure) ? pickedMeasure : measures[0] || null
  const energy = isEnergy(measure)

  const [view, setView] = useState('chart')
  const [rangeId, setRangeId] = useState(DEFAULT_RANGE.id)
  const [kwhRangeId, setKwhRangeId] = useState(DEFAULT_KWH_RANGE.id)
  // No raw ranges here: per-second rows for every meter in a mall is a
  // download nobody means to start from a button. They stay on the meter's
  // own page.
  const ranges = useMemo(() => offered(energy ? KWH_RANGES : RANGES, premium), [energy, premium])
  const wantedRangeId = energy ? kwhRangeId : rangeId
  // Derived, so a plan that changes mid-session falls back by itself.
  const range = useMemo(
    () => ranges.find((r) => r.id === wantedRangeId) || (energy ? DEFAULT_KWH_RANGE : DEFAULT_RANGE),
    [ranges, wantedRangeId, energy],
  )

  // Only the meters that report this reading at all.
  const carrying = useMemo(
    () => ordered.filter((t) => typeof t.values?.[measure]?.v === 'number'),
    [ordered, measure],
  )
  const idsKey = carrying.map((t) => t.id).join(' ')

  // Which meters are on the chart, each with its colour slot. Null until
  // someone chooses, so the default follows the meter list; an empty array
  // is a real choice and stays empty.
  const [picked, setPicked] = useState(null)
  const shown = useMemo(() => {
    const ids = idsKey ? idsKey.split(' ') : []
    if (picked) return picked.filter((s) => ids.includes(s.id))
    return defaultShown(ids, MAX_SERIES)
  }, [picked, idsKey])
  const visibleIds = useMemo(() => {
    const on = new Set(shown.map((s) => s.id))
    return (idsKey ? idsKey.split(' ') : []).filter((id) => on.has(id))
  }, [shown, idsKey])
  const colors = useMemo(() => {
    const slot = new Map(shown.map((s) => [s.id, s.slot]))
    const out = Object.fromEntries((idsKey ? idsKey.split(' ') : []).map((id) => [
      id,
      slot.has(id) ? colorForIndex(slot.get(id)) : 'var(--series-other)',
    ]))
    // The energy table's total column is nobody's line on the chart.
    out[ALL_METERS_KEY] = 'var(--series-other)'
    return out
  }, [shown, idsKey])
  const toggleMeter = (id) => setPicked(toggleShown(shown, id, MAX_SERIES))

  const tableView = view === 'table'
  const wantedKey = tableView ? idsKey : visibleIds.join(' ')

  // What each meter's feed has reported, held per (reading, range) so a
  // change of either can never show the previous one's rows under the new
  // heading. Only the slot on screen is kept.
  const slot = `${measure}@${range.id}`
  const [feeds, setFeeds] = useState({})
  const onData = useCallback((s, id, payload) => {
    setFeeds((prev) => {
      const current = prev[s] || {}
      if (payload) return { [s]: { ...current, [id]: payload } }
      if (!(id in current)) return prev
      const rest = { ...current }
      delete rest[id]
      return { ...prev, [s]: rest }
    })
  }, [])
  const feed = feeds[slot] || null

  // The window edge only has to move often enough for old points to fall
  // off; the same cadence the single-meter chart uses.
  const coarseNow = useNow(30_000)

  // Each meter as a series. Its tags/ entry arrives with its feed and only
  // refines what the projection already says, so the legend and the table
  // headings are right before any history has loaded.
  const meters = useMemo(
    () => carrying.map((t) => {
      const tag = meterTag(t, measure, feed?.[t.id]?.meta)
      // A threshold on the meter is a limit on its running total. What is
      // plotted here is energy per day, which it says nothing about.
      return energy ? { ...tag, loLimit: null, hiLimit: null } : tag
    }),
    [carrying, measure, feed, energy],
  )
  const wanted = useMemo(() => {
    const ids = new Set(wantedKey ? wantedKey.split(' ') : [])
    return meters.filter((m) => ids.has(m.key))
  }, [meters, wantedKey])

  const loading = wanted.some((m) => !feed?.[m.key] || feed[m.key].loading)
  const error = wanted.map((m) => feed?.[m.key]?.error).find(Boolean) || null

  const byKey = useMemo(() => {
    if (energy) return {}
    return Object.fromEntries(wanted.map((m) => [m.key, feed?.[m.key]?.rows || EMPTY]))
  }, [energy, wanted, feed])

  const merged = useMemo(
    () => (energy || tableView
      ? null
      : mergeSeries({ byKey, keys: visibleIds, range, nowMs: coarseNow })),
    [energy, tableView, byKey, visibleIds, range, coarseNow],
  )

  // The energy table is small (a row a day) and also feeds its chart, so it
  // is built in both views; the readings table only while it is on screen.
  const table = useMemo(() => {
    if (energy) return buildEnergyTable({ feeds: feed, meters: wanted })
    if (!tableView) return EMPTY_TABLE
    return withoutNow(buildTable({
      byKey,
      // No live value: see withoutNow.
      tags: wanted.map((m) => ({ ...m, value: null })),
      range,
      nowMs: coarseNow,
    }))
  }, [energy, tableView, feed, wanted, byKey, range, coarseNow])

  const chartRows = useMemo(
    () => (energy ? energyChartRows(table.rows, wanted) : merged?.rows || EMPTY),
    [energy, table, wanted, merged],
  )
  const chartTags = useMemo(
    () => meters.filter((m) => visibleIds.includes(m.key)),
    [meters, visibleIds],
  )

  if (!measure || carrying.length === 0) return null

  const unit = meters[0]?.unit
  const sub = energy
    ? (tableView
        ? 'Each meter’s daily reading and the energy used since its reading before, newest first'
        : 'Energy used between daily meter readings, one line per meter')
    : (tableView
        ? 'Every meter side by side, one row per recorded minute, newest first'
        : 'One-minute rollups, one line per meter')

  return (
    <section className="panel mall-history" aria-labelledby="mall-history-heading">
      {/* One feed per meter that is wanted right now. Components, not a loop
          over hooks: the number of meters changes at runtime, and a hook
          count that changes between renders is a crash. Keyed by slot so a
          new reading or range starts each of them afresh. */}
      {wanted.map((m) => (energy
        ? <KwhFeed key={`${slot}:${m.key}`} slot={slot} deviceId={m.key} range={range} onData={onData} />
        : (
          <SeriesFeed
            key={`${slot}:${m.key}`}
            slot={slot}
            deviceId={m.key}
            tagKey={measure}
            range={range}
            archive={premium}
            onData={onData}
          />
        )))}

      <div className="panel-head">
        <div>
          <div className="panel-title" id="mall-history-heading">
            {measure}{unit && unit !== measure ? ` (${unit})` : ''} · {tableView
              ? `all ${carrying.length} ${carrying.length === 1 ? 'meter' : 'meters'}`
              : carrying.length > visibleIds.length
                ? `${visibleIds.length} of ${carrying.length} meters`
                : `${carrying.length} ${carrying.length === 1 ? 'meter' : 'meters'}`}
          </div>
          <div className="panel-sub">
            {sub}
            {!tableView && carrying.length > MAX_SERIES
              && ` · the chart overlays up to ${MAX_SERIES}, picked below; the table has all of them`}
          </div>
        </div>

        <div className="panel-controls">
          {measures.length > 1 && (
            <div className="ranges" role="group" aria-label="Reading">
              {measures.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`range-btn ${k === measure ? 'range-active' : ''}`}
                  aria-pressed={k === measure}
                  onClick={() => setPickedMeasure(k)}
                >
                  {k}
                </button>
              ))}
            </div>
          )}

          <div className="ranges" role="group" aria-label="View">
            {[['chart', 'Chart'], ['table', 'Table']].map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`range-btn ${view === id ? 'range-active' : ''}`}
                aria-pressed={view === id}
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="ranges" role="group" aria-label="Time range">
            {ranges.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`range-btn ${r.id === range.id ? 'range-active' : ''}`}
                aria-pressed={r.id === range.id}
                onClick={() => (energy ? setKwhRangeId(r.id) : setRangeId(r.id))}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tableView ? (
        <DataTable
          columns={table.columns}
          groups={table.groups}
          rows={table.rows}
          colors={colors}
          range={range}
          // Names the file and the sheet: the company and the reading,
          // since one file holds every meter.
          deviceId={`${companyId}-${measure}`}
          loading={loading}
          error={error}
        />
      ) : (
        <Suspense
          fallback={<div className="chart-wrap"><div className="placeholder">Loading chart…</div></div>}
        >
          <HistoryChart
            tags={chartTags}
            colors={colors}
            data={chartRows}
            // "All time" has no length of its own; anything past two days
            // gets the axis that shows dates, which is what it needs.
            rangeMs={range.ms ?? 90 * DAY}
            raw={false}
            indexed={false}
            loading={loading}
            error={error}
            points={energy}
            emptyHint={energy
              ? 'A figure appears once a meter has two daily readings to compare.'
              : null}
          />
        </Suspense>
      )}

      {/* Picks the chart's meters. The table already has every one, so there
          it would only grey out columns that are plainly on screen. */}
      {!tableView && (
        <ChartLegend
          tags={meters}
          visible={visibleIds}
          colors={colors}
          onToggle={toggleMeter}
          atCapacity={visibleIds.length >= MAX_SERIES}
          maxSeries={MAX_SERIES}
        />
      )}
    </section>
  )
})

/**
 * One meter's history for one reading, reported upward. Renders nothing.
 *
 * Reads the meter's own tags/ entry first: that is where its push interval
 * lives, and the interval is what tells useSeriesHistory whether this tag
 * has minute rollups or only raw samples.
 */
const SeriesFeed = memo(function SeriesFeed({ slot, deviceId, tagKey, range, archive, onData }) {
  const meta = useRtdbValue(`devices/${deviceId}/tags/${tagKey}`, true)
  const tags = useMemo(() => [buildTag(tagKey, null, meta.data)], [tagKey, meta.data])
  const history = useSeriesHistory(tags, range, deviceId, !meta.loading, archive)
  const rows = history.byKey[tagKey]

  useEffect(() => {
    onData(slot, deviceId, {
      rows: rows || EMPTY,
      loading: meta.loading || history.loading,
      error: history.error,
      meta: meta.data,
    })
  }, [slot, deviceId, rows, meta.loading, meta.data, history.loading, history.error, onData])

  // A meter taken off the chart must not leave its last rows behind.
  useEffect(() => () => onData(slot, deviceId, null), [slot, deviceId, onData])

  return null
})

/** The same, for the meter's daily readings. */
const KwhFeed = memo(function KwhFeed({ slot, deviceId, range, onData }) {
  const { readings, since, loading, error } = useKwhHistory(deviceId, range, true)

  useEffect(() => {
    onData(slot, deviceId, { readings, since, loading, error })
  }, [slot, deviceId, readings, since, loading, error, onData])

  useEffect(() => () => onData(slot, deviceId, null), [slot, deviceId, onData])

  return null
})
