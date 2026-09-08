// The same window the chart draws, laid out as a grid instead of a picture.
//
// Deliberately built from the *raw* one-minute rollups in `byKey`, not from the
// merged rows lib/series.js hands the chart. Those are downsampled onto a
// render budget — the right trade for pixels, the wrong one for a table someone
// is about to read a number off or hand to a spreadsheet. A table asked to show
// "all data" has to mean every minute the device published.

import { displayUnit } from './tags'

const FIELD_LABEL = { min: 'min', avg: 'mean', max: 'max' }

/**
 * Column definitions and time-aligned rows for the tags currently on screen.
 *
 * Rows are the *union* of every minute any tag reported, ascending. A tag that
 * started later, or dropped out for an hour, leaves blanks rather than shifting
 * the others up a row — the whole point of a shared time column is that a
 * reading on one line happened at the same instant as its neighbours.
 *
 * @param byKey { [tagKey]: [{ t, min, avg, max, n }] } as cached by useSeriesHistory
 * @param tags  built tags, in display order
 */
export function buildTable({ byKey, tags, range, nowMs }) {
  const cutoff = nowMs - range.ms

  const columns = [{ id: 't', label: 'Time', kind: 'time' }]
  const groups = []

  for (const tag of tags) {
    // A mean of a boolean is 0.5 as often as not, and min/max of one is just
    // "did it ever change". One state column says more than three numbers.
    const fields = tag.dataType === 'bool' || tag.dataType === 'text'
      ? ['avg']
      : ['min', 'avg', 'max']
    const unit = displayUnit(tag)

    for (const field of fields) {
      columns.push({
        id: `${tag.key}:${field}`,
        label: fields.length === 1 ? tag.name : `${tag.name} ${FIELD_LABEL[field]}`,
        short: fields.length === 1 ? 'value' : FIELD_LABEL[field],
        unit,
        field,
        tag,
        kind: tag.dataType === 'bool' ? 'state' : tag.dataType === 'text' ? 'text' : 'num',
      })
    }

    groups.push({ key: tag.key, tag, unit, span: fields.length })
  }

  const byTime = new Map()

  for (const tag of tags) {
    for (const r of byKey[tag.key] || []) {
      if (r.t < cutoff) continue
      if (!Number.isFinite(r.avg)) continue

      let cells = byTime.get(r.t)
      if (!cells) {
        cells = {}
        byTime.set(r.t, cells)
      }

      // A rollup missing its envelope still has a mean; the mean stands in for
      // both bounds rather than the row losing the reading altogether.
      cells[`${tag.key}:avg`] = r.avg
      cells[`${tag.key}:min`] = numOr(r.min, r.avg)
      cells[`${tag.key}:max`] = numOr(r.max, r.avg)
    }
  }

  const rows = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, cells]) => ({ t, cells }))

  return { columns, groups, rows }
}

const numOr = (v, fallback) =>
  (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Header text for an exported column, unit included since there is no sub-row. */
export function exportHeader(column) {
  if (column.kind === 'time') return 'Time'
  return column.unit ? `${column.label} (${column.unit})` : column.label
}

/**
 * One exported cell.
 *
 * Numbers stay numbers so the spreadsheet can average them; only booleans are
 * rendered, because ON/OFF is what the tag means and a column of 1.0 and 0.0
 * invites summing it.
 */
export function exportCell(column, row) {
  if (column.kind === 'time') return new Date(row.t)
  const v = row.cells[column.id]
  if (v == null) return null
  if (column.kind === 'state') return Number(v) >= 0.5 ? 'ON' : 'OFF'
  if (column.kind === 'text') return String(v)
  return v
}
