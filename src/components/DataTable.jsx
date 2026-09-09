import { useMemo, useState } from 'react'
import { formatValue } from '../lib/tags'
import { formatLocal } from '../lib/time'
import { exportHeader, exportCell } from '../lib/table'
import { saveBlob, buildCsv, exportFilename } from '../lib/download'
import { isRawRange } from '../lib/ranges'

// Rows the browser will actually paint. A 7-day window is ten thousand minutes
// and ten thousand table rows is a locked-up phone, so the screen shows the
// newest slice and says so. The export is never capped — the whole point of
// having one is that the file is where the long tail lives.
const DISPLAY_LIMIT = 500

/**
 * The chart's window as a grid, newest first.
 *
 * Newest first because the question asked of a table on a plant floor is
 * almost always "what did it just do"; the workbook is written oldest-first
 * instead, which is the order a spreadsheet chart or a fill-down expects.
 */
export function DataTable({
  columns, groups, rows, colors, range, deviceId, loading, error,
}) {
  const [busy, setBusy] = useState(null)

  const shown = useMemo(
    () => rows.slice(-DISPLAY_LIMIT).reverse(),
    [rows],
  )

  // Hoisted out of the row loop: re-filtering thirteen columns five hundred
  // times over is work with nothing to show for it.
  const valueColumns = useMemo(
    () => columns.filter((c) => c.kind !== 'time'),
    [columns],
  )

  // A live reading, not a row of the window. It does not belong to any minute
  // in the table below it - it reads *right now*, not "as of the last
  // rollup" - so it is pinned above the historical rows instead of folded
  // into one, with everything but its own `now` cell left blank rather than
  // guessed from an aggregate that means something different.
  //
  // Skipped entirely in a raw range: there is no `now` column there (see
  // buildTable), and a raw table's own top row is already close to live, so a
  // separate pinned indicator would only repeat it.
  const raw = isRawRange(range)
  const nowRow = useMemo(() => {
    if (raw) return null
    const cells = {}
    let hasAny = false
    for (const g of groups) {
      if (g.tag.value != null) hasAny = true
      cells[`${g.key}:now`] = g.tag.value
    }
    return hasAny ? { cells } : null
  }, [groups, raw])

  const exportAs = async (kind) => {
    if (!rows.length) return
    setBusy(kind)
    try {
      const headers = columns.map(exportHeader)
      const cells = rows.map((row) => columns.map((c) => exportCell(c, row)))
      const name = exportFilename({
        deviceId,
        rangeLabel: range.label,
        ext: kind === 'xlsx' ? 'xlsx' : 'csv',
      })

      if (kind === 'csv') {
        saveBlob(buildCsv({ headers, rows: cells }), name)
      } else {
        // The workbook writer is dead weight for anyone who never exports, and
        // this dashboard is read on plant wifi. It arrives on the click.
        const { buildWorkbook } = await import('../lib/xlsx')
        const widths = columns.map((c) => (c.kind === 'time' ? 19 : undefined))
        saveBlob(
          buildWorkbook({
            sheetName: deviceId ? `${deviceId} ${range.label}` : 'Telemetry',
            columns: headers.map((header, i) => ({ header, width: widths[i] })),
            rows: cells,
          }),
          name,
        )
      }
    } finally {
      setBusy(null)
    }
  }

  if (error) {
    return <div className="placeholder">Could not read history: {error.message || String(error)}</div>
  }

  return (
    <div className="table-view">
      <div className="table-bar">
        <div className="table-count">
          {loading && !rows.length
            ? 'Loading…'
            : rows.length === 0
              ? 'No readings in this window'
              : rows.length > DISPLAY_LIMIT
                ? `Showing the newest ${DISPLAY_LIMIT.toLocaleString()} of ${rows.length.toLocaleString()} rows — the export has all of them`
                : `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}`}
        </div>
        <div className="table-actions">
          <button
            type="button"
            className="export-btn export-primary"
            onClick={() => exportAs('xlsx')}
            disabled={!rows.length || busy != null}
          >
            {busy === 'xlsx' ? 'Building…' : 'Export Excel'}
          </button>
          <button
            type="button"
            className="export-btn"
            onClick={() => exportAs('csv')}
            disabled={!rows.length || busy != null}
          >
            CSV
          </button>
        </div>
      </div>

      <div className="table-scroll" tabIndex={0} role="region" aria-label="Readings table">
        <table className="data-table">
          <thead>
            <tr>
              <th rowSpan={2} scope="col" className="col-time">Time</th>
              {groups.map((g) => (
                <th key={g.key} colSpan={g.span} scope="colgroup" className="col-group">
                  <span className="swatch" style={{ background: colors[g.key] }} aria-hidden="true" />
                  {g.tag.name}
                  {g.unit && <span className="col-unit"> ({g.unit})</span>}
                </th>
              ))}
            </tr>
            <tr>
              {valueColumns.map((c) => (
                <th key={c.id} scope="col" className="col-sub">{c.short}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nowRow && (
              <tr className="row-now">
                <th scope="row" className="col-time">Now</th>
                {valueColumns.map((c) => (
                  <td key={c.id} className={c.kind === 'num' ? 'num' : ''}>
                    {c.field === 'now' ? cellText(c, nowRow) : '—'}
                  </td>
                ))}
              </tr>
            )}
            {shown.map((row) => (
              <tr key={row.t}>
                <th scope="row" className="col-time">{formatLocal(row.t)}</th>
                {valueColumns.map((c) => (
                  <td key={c.id} className={c.kind === 'num' ? 'num' : ''}>
                    {cellText(c, row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {!shown.length && (
          <div className="placeholder">
            {loading ? 'Loading history…' : 'Nothing recorded in this window.'}
          </div>
        )}
      </div>
    </div>
  )
}

/** Same rendering rules the cards use, so a number reads alike in both places. */
function cellText(column, row) {
  const v = row.cells[column.id]
  if (v == null) return '—'
  return formatValue({ value: v, dataType: column.tag.dataType })
}
