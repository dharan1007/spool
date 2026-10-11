import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { xlsxEntriesToCsv } from '../src/xlsx-ingest.js';
import { unzipZip } from '../src/zip-reader.js';

const enc = new TextEncoder();
function entries(sheetXml, workbookXml = '<workbook><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>') {
  return {
    'xl/workbook.xml': enc.encode(workbookXml),
    'xl/_rels/workbook.xml.rels': enc.encode('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': enc.encode(sheetXml)
  };
}

function workbookRows(rows) {
  return '<worksheet><sheetData>' + rows.join('') + '</sheetData></worksheet>';
}
function inlineRow(r, value) {
  return '<row r="' + r + '"><c r="A' + r + '" t="inlineStr"><is><t>' + value + '</t></is></c></row>';
}

test('XLSX rejects an untrusted sparse row index before allocating empty rows', () => {
  const input = entries(workbookRows([inlineRow('999999999', 'ID')]));
  assert.throws(() => xlsxEntriesToCsv(input), /row.*(range|limit|index)|too many rows/i);
});

test('XLSX rejects duplicate and out-of-order worksheet row positions', () => {
  const duplicate = entries(workbookRows([inlineRow('1', 'ID'), inlineRow('2', 'First'), inlineRow('2', 'Second')]));
  const backwards = entries(workbookRows([inlineRow('3', 'ID'), inlineRow('2', 'Second')]));
  assert.throws(() => xlsxEntriesToCsv(duplicate), /row.*(order|duplicate|increasing)/i);
  assert.throws(() => xlsxEntriesToCsv(backwards), /row.*(order|duplicate|increasing)/i);
});

test('XLSX skips sparse blank leading positions without huge memory expansion', () => {
  const input = entries(workbookRows([inlineRow('5', 'ID'), inlineRow('6', '101')]));
  const result = xlsxEntriesToCsv(input);
  assert.equal(result.csv, 'ID\\n101\\n');
  assert.match(result.warnings.join(' '), /Skipped 4 blank rows/i);
});

test('XLSX does not silently select a hidden worksheet when none is visible', () => {
  const xml = '<workbook><sheets><sheet name="Hidden" state="hidden" r:id="rId1"/></sheets></workbook>';
  assert.throws(() => xlsxEntriesToCsv(entries(workbookRows([inlineRow('1', 'ID'), inlineRow('2', '1')]), xml)), /visible worksheet/i);
});

function zip(items) {
  const local = [], central = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name);
    const data = Buffer.from(item.data || '');
    const compressed = deflateRawSync(data);
    const declared = item.declaredSize ?? data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(declared, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, compressed);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(declared, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, Buffer.from(item.centralName || item.name));
    offset += lh.length + name.length + compressed.length;
  }
  const centralLength = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(centralLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

test('ZIP rejects misleadingly small declared expansion size', async () => {
  const file = zip([{ name: 'xl/workbook.xml', data: Buffer.alloc(2 * 1024 * 1024, 65), declaredSize: 8 }]);
  await assert.rejects(unzipZip(file), /size|ceiling|exceed/i);
});

test('ZIP rejects disagreement between central and local entry paths', async () => {
  const original = zip([{ name: 'xl/workbook.xml', data: Buffer.from('content') }]);
  const tampered = Buffer.from(original);
  const originalName = Buffer.from('xl/workbook.xml');
  const renamed = Buffer.from('xl/workboox.xml');
  assert.equal(originalName.length, renamed.length);
  const index = tampered.indexOf(originalName, 0);
  assert.ok(index >= 0);
  renamed.copy(tampered, index); // change only local-header entry name
  await assert.rejects(unzipZip(tampered), /entry.*(name|path)|mismatch/i);
});

test('ZIP rejects duplicated normalized entry names', async () => {
  const file = zip([{ name: 'xl/workbook.xml', data: 'one' }, { name: 'xl/workbook.xml', data: 'two' }]);
  await assert.rejects(unzipZip(file), /duplicate|entry.*already/i);
});

test('XLSX refuses duplicated cell coordinates and row-mismatched A1 references', () => {
  const duplicateCells = entries(workbookRows([
    '<row r="1"><c r="A1" t="inlineStr"><is><t>ID</t></is></c><c r="A1" t="inlineStr"><is><t>Name</t></is></c></row>',
    inlineRow('2', '101')
  ]));
  assert.throws(() => xlsxEntriesToCsv(duplicateCells), /duplicate cell/i);

  const mismatch = entries(workbookRows([
    inlineRow('1', 'ID'),
    '<row r="2"><c r="B3" t="inlineStr"><is><t>unexpected</t></is></c></row>'
  ]));
  assert.throws(() => xlsxEntriesToCsv(mismatch), /cell reference.*row/i);
});

test('XLSX refuses Excel 1900 serial 60 rather than inventing a date', () => {
  const input = {
    ...entries(workbookRows([
      inlineRow('1', 'Date'),
      '<row r="2"><c r="A2" s="0"><v>60</v></c></row>'
    ])),
    'xl/styles.xml': enc.encode('<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>')
  };
  assert.throws(() => xlsxEntriesToCsv(input), /serial 60|nonexistent.*leap/i);
});
