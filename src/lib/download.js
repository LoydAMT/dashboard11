// Handing a generated file to the browser, and the CSV alongside the workbook.

/** Save a Blob under a filename, cleaning up the object URL behind it. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  // Safari will not follow a click on a link that is not in the document.
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking synchronously races the download in Firefox.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * RFC 4180 CSV, with the two concessions Excel actually needs: a UTF-8 BOM so
 * tag names with degrees or micro signs survive the import, and CRLF endings.
 */
export function buildCsv({ headers, rows }) {
  const lines = [headers.map(csvField).join(',')]
  for (const row of rows) lines.push(row.map(csvField).join(','))
  return new Blob(['﻿' + lines.join('\r\n') + '\r\n'], {
    type: 'text/csv;charset=utf-8',
  })
}

function csvField(value) {
  if (value == null) return ''
  // A CSV has no cell types, so a Date has to be written as text. ISO-like but
  // space-separated: Excel parses it as a datetime in every locale tested,
  // where the 'T' form is left as a string in some.
  const text = value instanceof Date ? formatStamp(value) : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Local `YYYY-MM-DD HH:MM:SS`, matching the workbook's date format. */
function formatStamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Filesystem-safe stem, e.g. `RHW01-telemetry-6h-2026-09-08-1314`. */
export function exportFilename({ deviceId, rangeLabel, ext }) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}`
  const device = (deviceId || 'device').replace(/[^\w.-]+/g, '-')
  return `${device}-telemetry-${rangeLabel}-${stamp}.${ext}`
}
