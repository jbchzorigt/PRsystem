/**
 * A minimal, dependency-free `.xlsx` writer (doc 12 §7, doc 23 §8).
 *
 * An `.xlsx` is a ZIP of XML parts, and this writes exactly the four a
 * spreadsheet needs: the content types, the package relationship, the workbook
 * and one worksheet. Everything is an inline string — no shared-string table,
 * no styles, no number formats — because every value these exports carry is
 * already a string the server formatted, and a number format would be a second
 * place for a money value to be rounded.
 *
 * Written here rather than taken from a library for two reasons. It is small
 * and fully determined: the same rows produce byte-identical output, which is
 * what makes the content hash on an export job meaningful. And it adds no
 * dependency to a workspace whose lockfile is a governed artefact.
 *
 * The archive uses stored (uncompressed) entries. A registry export is at most
 * ten thousand short rows, so the size is unremarkable, and a stored entry has
 * no compressor to disagree with itself between runs.
 */

const encoder = new TextEncoder();

/**
 * Escapes the five characters XML reserves, and drops what it cannot carry.
 *
 * The control characters below `0x20` — other than tab, newline and carriage
 * return — are not representable in XML 1.0 at all, so they are removed rather
 * than escaped into something a reader would reject.
 */
function escapeXml(value: string): string {
  return (
    value
      // XML 1.0 cannot carry these at all, so they are removed rather than
      // escaped into something a reader would reject, and naming them by code
      // point is the only way to say which.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}

/** `A`, `B`, … `Z`, `AA` — a spreadsheet column name from a zero-based index. */
function columnName(index: number): string {
  let name = '';
  let cursor = index;
  do {
    name = String.fromCharCode(65 + (cursor % 26)) + name;
    cursor = Math.floor(cursor / 26) - 1;
  } while (cursor >= 0);
  return name;
}

function sheetXml(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[], rowNumber: number): string => {
    const body = cells
      .map(
        (value, column) =>
          `<c r="${columnName(column)}${String(rowNumber)}" t="inlineStr">` +
          `<is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`,
      )
      .join('');
    return `<row r="${String(rowNumber)}">${body}</row>`;
  };
  const body = [line(headers, 1), ...rows.map((cells, index) => line(cells, index + 2))].join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

function workbookXml(sheetName: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${escapeXml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '</Relationships>';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface Entry {
  readonly name: string;
  readonly body: Uint8Array;
}

/**
 * A ZIP archive of stored entries, with a fixed timestamp.
 *
 * Fixed on purpose: the export job records a content hash, and an archive that
 * embedded the clock would hash differently every run for the same rows.
 */
function zip(entries: readonly Entry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.body);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, 0, true); // stored, never deflated
    localView.setUint16(10, 0, true); // time
    localView.setUint16(12, 0x0021, true); // date: 1980-01-01
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.body.length, true);
    localView.setUint32(22, entry.body.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    chunks.push(local, entry.body);

    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(4, 20, true); // version made by
    recordView.setUint16(6, 20, true); // version needed
    recordView.setUint16(8, 0, true);
    recordView.setUint16(10, 0, true);
    recordView.setUint16(12, 0, true);
    recordView.setUint16(14, 0x0021, true);
    recordView.setUint32(16, crc, true);
    recordView.setUint32(20, entry.body.length, true);
    recordView.setUint32(24, entry.body.length, true);
    recordView.setUint16(28, name.length, true);
    recordView.setUint16(30, 0, true);
    recordView.setUint16(32, 0, true);
    recordView.setUint16(34, 0, true);
    recordView.setUint16(36, 0, true);
    recordView.setUint32(38, 0, true);
    recordView.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);

    offset += local.length + entry.body.length;
  }

  const centralSize = central.reduce((total, record) => total + record.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, end]) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/** One sheet, one header row, and the rows the caller already formatted. */
export function buildWorkbook(
  sheetName: string,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): Uint8Array {
  return zip([
    { name: '[Content_Types].xml', body: encoder.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', body: encoder.encode(ROOT_RELS) },
    { name: 'xl/workbook.xml', body: encoder.encode(workbookXml(sheetName)) },
    { name: 'xl/_rels/workbook.xml.rels', body: encoder.encode(WORKBOOK_RELS) },
    { name: 'xl/worksheets/sheet1.xml', body: encoder.encode(sheetXml(headers, rows)) },
  ]);
}
