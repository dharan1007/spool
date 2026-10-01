const MAX_WORKBOOK_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ROWS = 1_000_001;
const MAX_COLUMNS = 1000;

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58
]);

function decodeXml(value) {
  return String(value ?? '').replace(/&(?:#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, entity => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    if (entity.startsWith('&#x')) return String.fromCodePoint(Number.parseInt(entity.slice(3, -1), 16));
    return String.fromCodePoint(Number.parseInt(entity.slice(2, -1), 10));
  });
}

function readAttributes(tag) {
  const attrs = Object.create(null);
  for (const match of tag.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

function textFromEntry(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(value));
  throw new Error('XLSX archive entry has an unsupported representation.');
}

function requiredXml(entries, path) {
  const value = entries[path];
  if (!value) throw new Error(`XLSX archive is missing required part ${path}.`);
  return textFromEntry(value);
}

function optionalXml(entries, path) {
  const value = entries[path];
  return value ? textFromEntry(value) : '';
}

function normalizeZipPath(base, target) {
  if (!target) return '';
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const parts = `${base}/${target}`.split('/');
  const normalized = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return normalized.join('/');
}

function parseWorkbook(workbookXml) {
  const workbookPr = workbookXml.match(/<workbookPr\b[^>]*>/i)?.[0] ?? '';
  const date1904 = /date1904\s*=\s*(?:"1"|"true"|'1'|'true')/i.test(workbookPr);
  const sheets = [];
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*\/?>/gi)) {
    const attrs = readAttributes(match[0]);
    if (!attrs.name || !attrs['r:id']) continue;
    sheets.push({
      name: attrs.name,
      relationshipId: attrs['r:id'],
      hidden: String(attrs.state ?? '').toLowerCase() === 'hidden' || String(attrs.state ?? '').toLowerCase() === 'veryhidden'
    });
  }
  if (!sheets.length) throw new Error('XLSX workbook does not contain any worksheets.');
  return { date1904, sheets };
}

function parseRelationships(relsXml) {
  const map = new Map();
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?>/gi)) {
    const attrs = readAttributes(match[0]);
    if (attrs.Id && attrs.Target) map.set(attrs.Id, normalizeZipPath('xl', attrs.Target));
  }
  return map;
}

function parseSharedStrings(sharedXml) {
  if (!sharedXml) return [];
  const values = [];
  for (const match of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    const inner = match[1];
    const pieces = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(item => decodeXml(item[1]));
    values.push(pieces.join(''));
  }
  return values;
}

function looksLikeDateFormat(code) {
  const normalized = String(code ?? '')
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/_.|\\\*/g, '')
    .toLowerCase();
  return /(^|[^a-z])[dmyhs]+([^a-z]|$)/.test(normalized);
}

function looksLikeTimeFormat(code) {
  const normalized = String(code ?? '')
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase();
  return /h|s/.test(normalized);
}

function parseStyles(stylesXml) {
  const custom = new Map();
  for (const match of stylesXml.matchAll(/<numFmt\b[^>]*\/?>/gi)) {
    const attrs = readAttributes(match[0]);
    const id = Number.parseInt(attrs.numFmtId, 10);
    if (Number.isInteger(id)) custom.set(id, attrs.formatCode ?? '');
  }

  const cellXfsBlock = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/i)?.[1] ?? '';
  const styles = [];
  for (const match of cellXfsBlock.matchAll(/<xf\b[^>]*\/?>/gi)) {
    const attrs = readAttributes(match[0]);
    const numFmtId = Number.parseInt(attrs.numFmtId ?? '0', 10);
    const customCode = custom.get(numFmtId) ?? '';
    styles.push({
      isDate: BUILTIN_DATE_FORMATS.has(numFmtId) || looksLikeDateFormat(customCode),
      hasTime: [18, 19, 20, 21, 22, 45, 46, 47].includes(numFmtId) || looksLikeTimeFormat(customCode)
    });
  }
  return styles;
}

function columnIndex(reference) {
  const letters = String(reference ?? '').match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  if (!letters) return null;
  let value = 0;
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

function excelSerialToIso(raw, date1904, includeTime) {
  const serial = Number(raw);
  if (!Number.isFinite(serial)) return String(raw ?? '');
  const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31);
  const adjusted = !date1904 && serial >= 60 ? serial - 1 : serial;
  const millis = epoch + adjusted * 86_400_000;
  const date = new Date(millis);
  if (Number.isNaN(date.valueOf())) return String(raw ?? '');
  const iso = date.toISOString();
  return includeTime || Math.abs(adjusted % 1) > 1e-10 ? iso.slice(0, 19) : iso.slice(0, 10);
}

function cellValue(cellXml, sharedStrings, styles, date1904) {
  const opening = cellXml.match(/^<c\b[^>]*>/i)?.[0] ?? '<c>';
  const attrs = readAttributes(opening);
  const type = attrs.t ?? '';
  const styleIndex = Number.parseInt(attrs.s ?? '-1', 10);
  const style = Number.isInteger(styleIndex) && styleIndex >= 0 ? styles[styleIndex] : null;
  const rawValue = decodeXml(cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? '');

  if (type === 'inlineStr') {
    return [...cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(match => decodeXml(match[1])).join('');
  }
  if (type === 's') return sharedStrings[Number.parseInt(rawValue || '0', 10)] ?? '';
  if (type === 'b') return rawValue === '1' ? 'TRUE' : 'FALSE';
  if (type === 'str') return rawValue;
  if (type === 'e') return rawValue ? `#${rawValue}` : '#ERROR';
  if (type === 'd') {
    const date = new Date(rawValue);
    return Number.isNaN(date.valueOf()) ? rawValue : date.toISOString().replace(/\.000Z$/, 'Z');
  }
  if (style?.isDate && rawValue !== '') return excelSerialToIso(rawValue, date1904, style.hasTime);
  return rawValue;
}

function worksheetMatrix(sheetXml, sharedStrings, styles, date1904) {
  const matrix = [];
  let fallbackRow = 0;
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    if (matrix.length >= MAX_ROWS) throw new Error(`XLSX exceeds the Browser Studio limit of ${MAX_ROWS - 1} data rows.`);
    const rowTag = rowMatch[0].match(/^<row\b[^>]*>/i)?.[0] ?? '<row>';
    const rowAttrs = readAttributes(rowTag);
    const declared = Number.parseInt(rowAttrs.r ?? '', 10);
    const rowIndex = Number.isInteger(declared) && declared > 0 ? declared - 1 : fallbackRow;
    fallbackRow = rowIndex + 1;
    const row = [];
    let fallbackColumn = 0;
    for (const cellMatch of rowMatch[1].matchAll(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/gi)) {
      const opening = cellMatch[0].match(/^<c\b[^>]*\/?>/i)?.[0] ?? '<c>';
      const attrs = readAttributes(opening);
      const index = columnIndex(attrs.r) ?? fallbackColumn;
      if (index >= MAX_COLUMNS) throw new Error(`XLSX exceeds the Browser Studio limit of ${MAX_COLUMNS} columns.`);
      fallbackColumn = index + 1;
      row[index] = cellValue(cellMatch[0], sharedStrings, styles, date1904);
    }
    while (matrix.length < rowIndex) matrix.push([]);
    matrix[rowIndex] = row;
  }
  return matrix;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function matrixToCsv(matrix) {
  const firstContentRow = matrix.findIndex(row => Array.isArray(row) && row.some(value => String(value ?? '') !== ''));
  if (firstContentRow < 0) throw new Error('XLSX worksheet is empty.');
  const warnings = [];
  if (firstContentRow > 0) warnings.push(`Skipped ${firstContentRow} blank row${firstContentRow === 1 ? '' : 's'} before the header row.`);

  const trimmed = matrix.slice(firstContentRow);
  const headers = trimmed[0] ?? [];
  const width = Math.max(...trimmed.map(row => row.length), headers.length);
  if (!width) throw new Error('XLSX worksheet does not contain a header row.');
  if (width > MAX_COLUMNS) throw new Error(`XLSX exceeds the Browser Studio limit of ${MAX_COLUMNS} columns.`);

  const normalizedHeaders = Array.from({ length: width }, (_, index) => String(headers[index] ?? ''));
  const emptyHeaders = normalizedHeaders
    .map((header, index) => ({ header, index }))
    .filter(item => item.header.trim() === '');
  if (emptyHeaders.length) {
    throw new Error(`XLSX header row contains ${emptyHeaders.length} empty column name${emptyHeaders.length === 1 ? '' : 's'} (first at column ${emptyHeaders[0].index + 1}). Give every column a name before importing.`);
  }
  const seen = new Set();
  for (const header of normalizedHeaders) {
    if (seen.has(header)) throw new Error(`XLSX header "${header}" is duplicated. SPOOL requires unique source headers.`);
    seen.add(header);
  }

  const dataRows = trimmed.slice(1).filter(row => row.some(value => String(value ?? '') !== ''));
  if (!dataRows.length) throw new Error('XLSX worksheet contains headers but no data rows.');

  const lines = [
    normalizedHeaders.map(csvEscape).join(','),
    ...dataRows.map(row => Array.from({ length: width }, (_, index) => csvEscape(row[index] ?? '')).join(','))
  ];
  return {
    csv: `${lines.join('\n')}\n`,
    rowCount: dataRows.length,
    columnCount: width,
    warnings
  };
}

export function xlsxEntriesToCsv(entries) {
  if (!entries || typeof entries !== 'object') throw new Error('Invalid XLSX archive.');
  const workbookXml = requiredXml(entries, 'xl/workbook.xml');
  const workbook = parseWorkbook(workbookXml);
  const rels = parseRelationships(requiredXml(entries, 'xl/_rels/workbook.xml.rels'));
  const visibleSheet = workbook.sheets.find(sheet => !sheet.hidden) ?? workbook.sheets[0];
  const sheetPath = rels.get(visibleSheet.relationshipId);
  if (!sheetPath) throw new Error(`XLSX relationship ${visibleSheet.relationshipId} for worksheet "${visibleSheet.name}" is missing.`);

  const sharedStrings = parseSharedStrings(optionalXml(entries, 'xl/sharedStrings.xml'));
  const styles = parseStyles(optionalXml(entries, 'xl/styles.xml'));
  const matrix = worksheetMatrix(requiredXml(entries, sheetPath), sharedStrings, styles, workbook.date1904);
  const converted = matrixToCsv(matrix);
  return {
    ...converted,
    sheetName: visibleSheet.name,
    sheetNames: workbook.sheets.map(sheet => sheet.name),
    dateSystem: workbook.date1904 ? '1904' : '1900'
  };
}

export async function xlsxFileToCsv(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Choose a valid .xlsx file.');
  if (Number(file.size ?? 0) > MAX_WORKBOOK_BYTES) {
    throw new Error('Browser Studio accepts CSV/XLSX files up to 50 MiB.');
  }

  const { unzipZip } = await import('./zip-reader.js');
  let entries;
  try {
    entries = await unzipZip(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    throw new Error(`Unable to open XLSX workbook: ${error?.message || String(error)}`);
  }

  const expandedBytes = Object.values(entries).reduce((total, entry) => total + Number(entry?.byteLength ?? 0), 0);
  if (expandedBytes > MAX_UNCOMPRESSED_BYTES) {
    throw new Error('XLSX expands beyond the 256 MiB browser safety ceiling. Reduce the workbook before importing.');
  }

  return xlsxEntriesToCsv(entries);
}
