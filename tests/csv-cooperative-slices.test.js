import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvAsync } from '../src/core/csv.js';

const toPlain = result => JSON.parse(JSON.stringify(result));

test('optimized CSV slices preserve embedded commas, doubled quotes and CRLF', () => {
  const input = 'id,note,flag\r\n1,"a,b","hello ""world"""\r\n2,"line one\nline two",yes\r\n3,plain"quote",no';
  const result = toPlain(parseCsv(input));
  assert.deepEqual(result, { headers: ['id', 'note', 'flag'], rows: [
    { id: '1', note: 'a,b', flag: 'hello "world"' },
    { id: '2', note: 'line one\nline two', flag: 'yes' },
    { id: '3', note: 'plain"quote', flag: 'no' }
  ] });
});

test('cooperative parser equals synchronous parser across deterministic malformed and valid CSV corpus', async () => {
  let seed = 712733;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const alphabet = ['a', 'b', '7', ',', '"', '\r', '\n', ' ', '✓'];
  const cases = ['id,value\n1,ok\n', 'id,value\r\n1,"quoted, value"\r\n', 'id,value\n1,"x""y"\n',
    'id,value\n1,"unterminated', 'id,value\n1,', 'id,value\n1,hello', 'id,value\n2,""'];
  for (let i = 0; i < 350; i++) {
    let source = 'id,value\n';
    const length = next() % 170;
    for (let j = 0; j < length; j++) source += alphabet[next() % alphabet.length];
    cases.push(source);
  }
  function outcome(fn) {
    try { return { ok: true, value: toPlain(fn()) }; }
    catch (error) { return { ok: false, code: error.code, message: error.message }; }
  }
  for (const source of cases) {
    const expected = outcome(() => parseCsv(source));
    const observed = await (async () => {
      try { return { ok: true, value: toPlain(await parseCsvAsync(source)) }; }
      catch (error) { return { ok: false, code: error.code, message: error.message }; }
    })();
    assert.deepEqual(observed, expected, 'Sync and async parsing diverged for source ' + JSON.stringify(source).slice(0, 130));
  }
});

test('cooperative parser preserves 1 MiB cell ceiling and multiline quote semantics', async () => {
  const limit = 1024 * 1024;
  const input = 'text\n"' + 'A'.repeat(limit - 5) + '""x"\n';
  const parsed = await parseCsvAsync(input);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].text.length, limit - 4);
  await assert.rejects(parseCsvAsync('text\n"' + 'a'.repeat(limit + 1) + '"'), /CELL_TOO_LARGE/);
});

test('CSV parser preserves 50 MiB input-byte enforcement, not UTF-16 character count', async () => {
  await assert.rejects(parseCsvAsync('id\n☃\n', { maxInputBytes: 5 }), /SOURCE_TOO_LARGE/);
  assert.equal((await parseCsvAsync('id\n☃\n', { maxInputBytes: 7 })).rows[0].id, '☃');
});

test('long CSV parsing with bounded 64 KiB yields produces correct complete row accounting', async () => {
  const count = 16000;
  const csv = 'id,value\n' + Array.from({ length: count }, (_, i) => i + ',chunk-value-' + i).join('\n');
  const result = await parseCsvAsync(csv);
  assert.equal(result.rows.length, count);
  assert.equal(result.rows[0].id, '0');
  assert.equal(result.rows[count - 1].value, 'chunk-value-' + (count - 1));
});
