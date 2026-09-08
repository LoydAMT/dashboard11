// A real .xlsx, written by hand.
//
// The alternative was a CSV renamed, or a spreadsheet library. A CSV loses the
// distinction between a timestamp and the text that looks like one — Excel
// re-guesses every column on import, and it guesses wrong on ISO timestamps in
// several locales. A library would be the largest dependency in the project for
// one button. An .xlsx is a ZIP of six small XML parts, and the only piece with
// any real difficulty in it is the CRC.
//
// Stored (uncompressed) entries only: the sheet would compress well, but a
// DEFLATE implementation is real work and the file exists to be opened once.

const encoder = new TextEncoder()

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Build a single-sheet workbook.
 *
 * A cell is a number, a string, a Date, or null for blank. Numbers stay numbers
 * so the spreadsheet can average a column; dates are written as real Excel
 * serials so a date filter or a chart works on them.
 *
 * @param columns [{ header, width }] or plain header strings
 * @param rows    array of cell arrays, one per sheet row
 * @returns Blob
 */
export function buildWorkbook({ sheetName = 'Sheet1', columns, rows }) {
  const headers = columns.map((c) => (typeof c === 'string' ? c : c.header))
  const widths = columns.map((c, i) =>
    (typeof c === 'string' ? 0 : c.width) || Math.min(38, Math.max(12, headers[i].length + 3)))

  const parts = [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['xl/workbook.xml', workbookXml(sheetName)],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', sheetXml(headers, widths, rows)],
  ]

  return zip(parts.map(([name, text]) => ({ name, data: encoder.encode(text) })))
}

/* --------------------------------------------------------------- sheet XML */

function sheetXml(headers, widths, rows) {
  const lastCol = colName(headers.length - 1)
  const out = []

  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">')
  out.push(`<dimension ref="A1:${lastCol}${rows.length + 1}"/>`)
  // The header has to stay put. A telemetry export runs to thousands of rows,
  // and a column of bare numbers three screens down means nothing.
  out.push('<sheetViews><sheetView workbookViewId="0">'
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '</sheetView></sheetViews>')
  out.push('<sheetFormatPr defaultRowHeight="15"/>')

  out.push('<cols>')
  widths.forEach((w, i) => {
    out.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
  })
  out.push('</cols>')

  out.push('<sheetData>')
  out.push(`<row r="1">${headers.map((h, i) => cellXml(colName(i), 1, h, STYLE_HEADER)).join('')}</row>`)

  rows.forEach((row, r) => {
    const n = r + 2
    const cells = row.map((value, i) => cellXml(colName(i), n, value)).join('')
    out.push(`<row r="${n}">${cells}</row>`)
  })
  out.push('</sheetData>')

  out.push(`<autoFilter ref="A1:${lastCol}${rows.length + 1}"/>`)
  out.push('</worksheet>')

  return out.join('')
}

const STYLE_GENERAL = 0
const STYLE_DATE = 1
const STYLE_HEADER = 2

function cellXml(col, rowNum, value, style) {
  const ref = `${col}${rowNum}`

  // A blank cell is genuinely absent from the XML — writing an empty <c> for
  // every gap in a sparse export doubles the file for nothing.
  if (value == null || value === '') {
    return style ? `<c r="${ref}" s="${style}"/>` : ''
  }

  if (value instanceof Date) {
    return `<c r="${ref}" s="${STYLE_DATE}"><v>${excelSerial(value)}</v></c>`
  }

  const s = style ?? STYLE_GENERAL
  const attr = s ? ` s="${s}"` : ''

  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${attr}><v>${value}</v></c>`
  }

  return `<c r="${ref}"${attr} t="inlineStr"><is><t xml:space="preserve">`
    + escapeXml(String(value))
    + '</t></is></c>'
}

/**
 * Excel's day count, in the viewer's own zone.
 *
 * Serials carry no timezone, so the offset has to be folded in here or a 14:05
 * reading opens as 06:05 for anyone west of UTC — the one mistake in a
 * telemetry export nobody notices until they have already drawn conclusions
 * from it. 25569 is 1970-01-01 in the 1900 date system.
 */
function excelSerial(date) {
  const localMs = date.getTime() - date.getTimezoneOffset() * 60_000
  return (localMs / 86_400_000 + 25569).toFixed(10).replace(/0+$/, '').replace(/\.$/, '')
}

/** Spreadsheet column letters: 0 -> A, 26 -> AA. */
function colName(index) {
  let n = index
  let name = ''
  do {
    name = String.fromCharCode(65 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return name
}

const escapeXml = (s) =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
    // Control characters cannot be represented in XML 1.0 at all, and tag names
    // come from the device: one stray byte would make the file unopenable
    // rather than merely ugly. Matching them is the point, hence the exemption.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

/* ------------------------------------------------------ fixed package parts */

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + '</Types>'

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>'

const WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>'

const workbookXml = (sheetName) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
  + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
  + `<sheets><sheet name="${escapeXml(sanitiseSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>`
  + '</workbook>'

/** Excel rejects these characters in a tab name, and anything past 31 chars. */
const sanitiseSheetName = (name) =>
  (name || 'Sheet1').replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Sheet1'

// numFmtId 164 is the first id available to custom formats; everything below it
// is reserved for the built-ins.
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts>'
  + '<fonts count="2">'
  + '<font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
  + '</fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>'

/* -------------------------------------------------------------------- ZIP */

/** Store-only ZIP: entries in order, then the central directory, then the end. */
function zip(entries) {
  const chunks = []
  const central = []
  let offset = 0

  const { time, date } = dosStamp(new Date())

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)       // version needed to extract
    lv.setUint16(6, 0x0800, true)   // names are UTF-8
    lv.setUint16(8, 0, true)        // stored, not deflated
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)       // no extra field
    local.set(name, 30)

    chunks.push(local, entry.data)

    const dir = new Uint8Array(46 + name.length)
    const dv = new DataView(dir.buffer)
    dv.setUint32(0, 0x02014b50, true)
    dv.setUint16(4, 20, true)       // version made by
    dv.setUint16(6, 20, true)       // version needed to extract
    dv.setUint16(8, 0x0800, true)
    dv.setUint16(10, 0, true)
    dv.setUint16(12, time, true)
    dv.setUint16(14, date, true)
    dv.setUint32(16, crc, true)
    dv.setUint32(20, size, true)
    dv.setUint32(24, size, true)
    dv.setUint16(28, name.length, true)
    dv.setUint32(42, offset, true)  // offset of this entry's local header
    dir.set(name, 46)

    central.push(dir)
    offset += local.length + size
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0)

  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  return new Blob([...chunks, ...central, end], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

/** MS-DOS packed date/time, the only stamp a ZIP header has room for. */
function dosStamp(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}
