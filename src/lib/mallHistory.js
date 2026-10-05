// A whole company's meters on one chart and in one table (see
// components/MallHistory.jsx).
//
// The single-meter dashboard compares several TAGS of one meter. This is the
// other way round: one tag, every meter that reports it. The chart, the table
// and the export are the same components either way, because they are
// written against "a list of series with a key, a name and a unit" - so each
// meter is handed to them as a series keyed by its device id.

import { DAY, HOUR } from './time'
import { KWH_TAG_KEY, buildKwhRows } from './kwh'
import { buildTag } from './tags'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * The meter gets its own treatment: no rollups exist for it, and what a
 * landlord wants from it is consumption per day, not the running total.
 */
export const isEnergy = (key) => key === KWH_TAG_KEY

/**
 * Every reading any tenant reports, in the order the tiles prefer: what a
 * landlord most often watches first, the accumulator last.
 */
export function measurementKeys(tenants) {
  const keys = new Set()
  for (const t of tenants || []) {
    for (const [k, entry] of Object.entries(t.values || {})) {
      if (num(entry?.v) != null) keys.add(k)
    }
  }
  const preferred = ['Current', 'Power', 'kW', 'Voltage']
  return [...keys].sort((a, b) => {
    const ia = preferred.indexOf(a)
    const ib = preferred.indexOf(b)
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    const ka = /kwh/i.test(a) ? 1 : 0
    const kb = /kwh/i.test(b) ? 1 : 0
    return ka !== kb ? ka - kb : a.localeCompare(b)
  })
}

/**
 * One meter, shaped as the series the chart and the table expect.
 *
 * Keyed by DEVICE id and named after the tenant. Unit, thresholds and the
 * current reading come from the overview projection, which is already on
 * screen; `meta` is the device's own tags/ entry once it has been read, and
 * only adds what the projection does not carry (the data type, the deadband).
 */
export function meterTag(tenant, tagKey, meta = null) {
  const entry = tenant.values?.[tagKey] || {}
  const base = buildTag(tagKey, null, meta)
  const value = num(entry.v)
  return {
    ...base,
    key: tenant.id,
    name: tenant.name,
    unit: base.unit ?? entry.u ?? null,
    value,
    hasReading: value != null,
    loLimit: num(entry.lo) ?? base.loLimit,
    hiLimit: num(entry.hi) ?? base.hiLimit,
  }
}

/** The first `max` meters, each on its own colour slot. */
export function defaultShown(ids, max) {
  return ids.slice(0, max).map((id, slot) => ({ id, slot }))
}

/**
 * Show or hide one meter on the chart.
 *
 * A meter keeps its colour for as long as it stays on the chart, and a newly
 * added one takes the lowest slot nobody is using - so hiding one line never
 * repaints the others. Slots are handed out per chart rather than per meter
 * because a mall has far more meters than there are colours.
 */
export function toggleShown(shown, id, max) {
  if (shown.some((s) => s.id === id)) return shown.filter((s) => s.id !== id)
  if (shown.length >= max) return shown
  const used = new Set(shown.map((s) => s.slot))
  let slot = 0
  while (used.has(slot)) slot += 1
  return [...shown, { id, slot }]
}

/**
 * The table without its live "now" column.
 *
 * On one meter that column is the reading as of this second. Here the only
 * current values in hand are the overview's, up to two minutes old - close
 * enough for a tile, not for a column headed "now" beside exact minutes.
 */
export function withoutNow(table) {
  const columns = table.columns.filter((c) => c.field !== 'now')
  const groups = table.groups.map((g) => ({
    ...g,
    span: columns.filter((c) => c.tag?.key === g.key).length,
  }))
  return { columns, groups, rows: table.rows }
}

// ---------------------------------------------------------------- energy

// The boxes take the day's meter reading at 22:00 Philippine time, 14:00 UTC
// (see functions/billing.js). A "meter day" runs from one such reading to the
// next, so a reading taken a few seconds - or, after an outage, a few hours -
// late still lands on the day it closes.
const READ_HOUR_UTC = 14
export const meterDay = (t) => Math.floor((t - READ_HOUR_UTC * HOUR) / DAY)

/**
 * One reading per meter day: the first at or after the 22:00 mark, which is
 * the one billing uses. A box that also pushes on start-up or twice a day
 * would otherwise put several rows in a table that is one row per day.
 */
export function dailyReadings(readings) {
  const out = []
  let last = null
  for (const r of readings || []) {
    const day = meterDay(r.t)
    if (day === last) continue
    last = day
    out.push(r)
  }
  return out
}

const round3 = (v) => Number(v.toFixed(3))

/**
 * Stands in for a tag on the total's columns. A forward slash is the one
 * character an RTDB key can never contain, so this cannot collide with a
 * real device id.
 */
export const ALL_METERS_KEY = '/all'
const ALL_METERS = { key: ALL_METERS_KEY, name: 'All meters', dataType: 'num', value: null }

/**
 * Every meter's daily reading and the energy used since its previous one,
 * as the columns/groups/rows DataTable draws and exports.
 *
 * Rows are meter days, so three meters read a second apart share a row. The
 * total says how many meters it covers: a figure spanning two of three
 * meters is misleading unless the row admits it.
 *
 * @param feeds   { [deviceId]: { readings, since } } as useKwhHistory returns
 * @param meters  meterTag()s, in display order
 */
export function buildEnergyTable({ feeds, meters }) {
  const columns = [{ id: 't', label: 'Time', kind: 'time' }]
  const groups = []
  const byDay = new Map()

  for (const m of meters) {
    // No live "now" row: this table is closed days only.
    const tag = { ...m, value: null }
    columns.push(
      { id: `${m.key}:reading`, label: `${m.name} reading`, short: 'reading', unit: m.unit, field: 'reading', tag, kind: 'num' },
      { id: `${m.key}:used`, label: `${m.name} used`, short: 'used', unit: m.unit, field: 'used', tag, kind: 'num' },
    )
    groups.push({ key: m.key, tag, unit: m.unit, span: 2 })

    const feed = feeds?.[m.key]
    if (!feed) continue
    for (const r of buildKwhRows(dailyReadings(feed.readings), feed.since ?? null)) {
      const day = meterDay(r.t)
      let row = byDay.get(day)
      if (!row) {
        row = { t: r.t, cells: {}, used: 0, counted: 0 }
        byDay.set(day, row)
      }
      // The earliest actual reading names the row - in the ordinary case
      // that is 22:00:00 for all of them.
      if (r.t < row.t) row.t = r.t
      row.cells[`${m.key}:reading`] = r.value
      // A meter that went backwards has no figure (see buildKwhRows), and so
      // adds nothing to the total rather than a negative amount.
      if (r.delta != null) {
        row.cells[`${m.key}:used`] = round3(r.delta)
        row.used += r.delta
        row.counted += 1
      }
    }
  }

  if (meters.length > 1) {
    const unit = meters[0].unit
    const tag = { ...ALL_METERS, unit }
    columns.push(
      { id: `${tag.key}:used`, label: 'All meters used', short: 'used', unit, field: 'used', tag, kind: 'num' },
      { id: `${tag.key}:count`, label: 'Meters counted', short: 'meters', unit: null, field: 'count', tag, kind: 'num' },
    )
    groups.push({ key: tag.key, tag, unit, span: 2 })
    for (const row of byDay.values()) {
      if (row.counted === 0) continue
      row.cells[`${tag.key}:used`] = round3(row.used)
      row.cells[`${tag.key}:count`] = row.counted
    }
  }

  const rows = [...byDay.values()]
    .sort((a, b) => a.t - b.t)
    .map(({ t, cells }) => ({ t, cells }))

  return { columns, groups, rows }
}

/** The same rows as chart points: each meter's energy used, per meter day. */
export function energyChartRows(rows, meters) {
  return rows.map((row) => {
    const point = { t: row.t, raw: {} }
    for (const m of meters) {
      const v = row.cells[`${m.key}:used`]
      if (v == null) continue
      point[m.key] = v
      point.raw[m.key] = v
    }
    return point
  })
}
