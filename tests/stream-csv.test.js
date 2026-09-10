import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsv } from '../src/core/csv.js';
import { streamCsvRows, inspectCsvStream } from '../src/connectors/filesystem/stream-csv.js';

async function withCsv(bytes, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-stream-csv-'));
  const path = join(dir, 'source.csv');
  try {
    await writeFile(path, bytes);
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function collect(path, options = {}) {
  const rows = [];
  for await (const item of streamCsvRows(path, options)) rows.push(item);
  return rows;
}

for (const highWaterMark of [1, 2, 3, 5, 7]) {
  test(`stream parser matches parseCsv across adversarial ${highWaterMark}-byte chunks`, async () => {
    const text = 'name,notes,city\r\n"Ada, A.","line 1\nline 2","Hyderābād"\r\nLin,"said ""hello""",東京\r\n';
    await withCsv(Buffer.from(text, 'utf8'), async path => {
      const expected = parseCsv(text);
      const actual = await collect(path, { highWaterMark });
      assert.deepEqual(actual.map(item => item.row), expected.rows);
      assert.deepEqual(actual.map(item => item.rowIndex), [0, 1]);
      const inspected = await inspectCsvStream(path, { highWaterMark, sampleSize: 1 });
      assert.deepEqual(inspected.headers, expected.headers);
      assert.equal(inspected.rowCount, 2);
      assert.deepEqual(inspected.sampleRows, expected.rows.slice(0, 1));
    });
  });
}

test('stream parser preserves empty cells and trailing empty columns', async () => {
  const text = 'a,b,c\n1,,\n,2,3\n';
  await withCsv(text, async path => {
    const rows = await collect(path, { highWaterMark: 2 });
    assert.deepEqual(rows.map(x => x.row), parseCsv(text).rows);
  });
});

test('stream parser rejects unsafe and duplicate headers with stable codes', async () => {
  for (const [text, code] of [
    ['__proto__,x\n1,2\n', 'UNSAFE_HEADER'],
    ['a,a\n1,2\n', 'DUPLICATE_HEADER'],
    [',b\n1,2\n', 'EMPTY_HEADER']
  ]) {
    await withCsv(text, async path => {
      await assert.rejects(async () => collect(path, { highWaterMark: 1 }), error => error?.code === code);
    });
  }
});

test('stream parser rejects malformed row width and unclosed quotes', async () => {
  await withCsv('a,b\n1\n', async path => {
    await assert.rejects(async () => collect(path, { highWaterMark: 1 }), error => error?.code === 'COLUMN_COUNT_MISMATCH');
  });
  await withCsv('a,b\n"unterminated,2', async path => {
    await assert.rejects(async () => collect(path, { highWaterMark: 2 }), error => error?.code === 'UNCLOSED_QUOTE');
  });
});

test('stream parser enforces cell, row and column limits without materializing prior rows', async () => {
  await withCsv('a\nabcdef\n', async path => {
    await assert.rejects(async () => collect(path, { maxCellLength: 3 }), error => error?.code === 'CELL_TOO_LARGE');
  });
  await withCsv('a\n1\n2\n', async path => {
    await assert.rejects(async () => collect(path, { maxRows: 1 }), error => error?.code === 'TOO_MANY_ROWS');
  });
  await withCsv('a,b\n1,2\n', async path => {
    await assert.rejects(async () => collect(path, { maxColumns: 1 }), error => error?.code === 'TOO_MANY_COLUMNS');
  });
});

test('stream parser rejects invalid UTF-8 even when invalid sequence crosses chunks', async () => {
  const bytes = Buffer.from([0x61, 0x0a, 0x31, 0xc3, 0x28, 0x0a]);
  await withCsv(bytes, async path => {
    await assert.rejects(async () => collect(path, { highWaterMark: 1 }), error => error?.code === 'INVALID_SOURCE_ENCODING');
  });
});
