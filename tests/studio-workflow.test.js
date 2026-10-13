
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { xlsxEntriesToCsv } from '../src/xlsx-ingest.js';

const [html, app, flow, styles, kernel, xlsx, zip] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/studio-flow.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/core/command-kernel.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/xlsx-ingest.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/zip-reader.js', import.meta.url), 'utf8')
]);

test('Studio exposes seven separate ordered workflow routes', () => {
  const routes = [
    '/studio/original',
    '/studio/inspect',
    '/studio/understand',
    '/studio/transform',
    '/studio/test',
    '/studio/process',
    '/studio/validate'
  ];
  let last = -1;
  for (const route of routes) {
    const index = flow.indexOf(route);
    assert.ok(index > last, 'missing or out-of-order Studio route: ' + route);
    last = index;
  }
  for (const phrase of [
    'Original file',
    'Inspect the data',
    'Understand columns',
    'Prepare transformation',
    'Test without changes',
    'Process the data',
    'Validate results'
  ]) assert.ok(flow.includes(phrase), 'missing Studio stage label: ' + phrase);
});

test('legacy Studio renderer cannot replace the seven-stage workflow', () => {
  assert.match(app, /STUDIO_FLOW_PATHS/);
  assert.match(app, /data-spool-flow-root/);
  assert.match(app, /spool:studio-route/);
  assert.match(app, /spool:statechange/);
  assert.match(flow, /window\.addEventListener\('spool:studio-route', schedule\)/);
  assert.match(flow, /window\.addEventListener\('spool:statechange', schedule\)/);
  assert.ok(app.indexOf("if (STUDIO_FLOW_PATHS.has(path))") < app.indexOf("const pages = {"),
    'Studio handoff must occur before legacy page dispatch');
});

test('Studio workflow separates approval, dry run, execution and validation', () => {
  assert.match(flow, /define_target_schema/);
  assert.match(flow, /set_mapping/);
  assert.match(flow, /validate_mapping/);
  assert.match(flow, /preview_migration/);
  assert.match(flow, /start_migration/);
  assert.match(flow, /Dry test required/);
  assert.match(flow, /non-committing test/i);
  assert.match(flow, /first stage that commits transformed records/i);
  assert.match(flow, /FINAL VALIDATION/);
});

test('Browser Studio accepts CSV and XLSX without adding a network data plane', () => {
  assert.match(html, /src="\/src\/studio-flow\.js"/);
  assert.match(app, /\.xlsx/);
  assert.match(app, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(flow, /Drop CSV or XLSX here/);
  assert.match(flow, /first visible worksheet/i);
  assert.match(flow, /Formulas are not executed/i);
  assert.match(kernel, /input: \['CSV', 'XLSX'\]/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(flow, /https?:\/\//);
  assert.doesNotMatch(xlsx, /https?:\/\//);
  assert.doesNotMatch(zip, /https?:\/\//);
});

test('XLSX worksheet XML is converted deterministically to CSV', () => {
  const enc = new TextEncoder();
  const entries = {
    'xl/workbook.xml': enc.encode('<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Customers" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': enc.encode('<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': enc.encode('<sst><si><t>Customer ID</t></si><si><t>Name</t></si><si><t>Ada</t></si><si><t>Grace</t></si></sst>'),
    'xl/styles.xml': enc.encode('<styleSheet><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>'),
    'xl/worksheets/sheet1.xml': enc.encode('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2" t="s"><v>2</v></c></row><row r="3"><c r="A3"><v>2</v></c><c r="B3" t="s"><v>3</v></c></row></sheetData></worksheet>')
  };
  const result = xlsxEntriesToCsv(entries);
  assert.equal(result.sheetName, 'Customers');
  assert.equal(result.rowCount, 2);
  assert.equal(result.columnCount, 2);
  assert.equal(result.csv, 'Customer ID,Name\n1,Ada\n2,Grace\n');
});

test('XLSX import fails closed on duplicate or empty headers', () => {
  const enc = new TextEncoder();
  const base = {
    'xl/workbook.xml': enc.encode('<workbook xmlns:r="x"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': enc.encode('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/styles.xml': enc.encode('<styleSheet><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>')
  };
  const duplicate = {
    ...base,
    'xl/sharedStrings.xml': enc.encode('<sst><si><t>ID</t></si><si><t>A</t></si></sst>'),
    'xl/worksheets/sheet1.xml': enc.encode('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>1</v></c></row></sheetData></worksheet>')
  };
  assert.throws(() => xlsxEntriesToCsv(duplicate), /duplicated/i);

  const empty = {
    ...base,
    'xl/sharedStrings.xml': enc.encode('<sst><si><t>ID</t></si><si><t>A</t></si></sst>'),
    'xl/worksheets/sheet1.xml': enc.encode('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v></v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>1</v></c></row></sheetData></worksheet>')
  };
  assert.throws(() => xlsxEntriesToCsv(empty), /empty column name/i);
});

test('Studio serializes overlapping real CSV/XLSX source imports until durable replacement completes', () => {
  const upload = flow.slice(flow.indexOf('async function upload(file)'), flow.indexOf('async function approve()'));
  assert.ok(upload.startsWith('async function upload(file)'), 'source upload handler missing');
  assert.match(upload, /if \(!file \|\| busyAction\) return/);
  assert.match(upload, /busyAction = true;\s*schedule\(\);\s*try \{/);
  assert.match(upload, /await module\.xlsxFileToCsvInWorker\(file\)/);
  assert.match(upload, /await api\(\)\.loadCsv\(text, file\.name\)/);
  assert.match(upload, /finally \{\s*busyAction = false;\s*schedule\(\)/);
});

test('visual system contains responsive seven-stage Studio primitives', () => {
  for (const selector of [
    '.spool-flow',
    '.flow-sidebar',
    '.flow-step',
    '.flow-dropzone',
    '.flow-table',
    '.flow-outcomes',
    '.flow-safety-banner',
    '.flow-process-panel',
    '.flow-validation-hero'
  ]) assert.ok(styles.includes(selector), 'missing Studio style: ' + selector);
  assert.match(styles, /@media\(max-width:760px\)/);
});
