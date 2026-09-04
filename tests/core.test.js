import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, transition, PHASES } from '../src/core/state-machine.js';
import { inferSchema, fingerprintText } from '../src/core/schema.js';
import { parseCsv } from '../src/core/csv.js';

test('job starts EMPTY and rejects illegal transition', () => {
  const job = createJob('job_1');
  assert.equal(job.phase, PHASES.EMPTY);
  assert.throws(() => transition(job, PHASES.RUNNING), /INVALID_TRANSITION/);
});

test('valid migration path reaches COMPLETE', () => {
  let job = createJob('job_1');
  for (const phase of [PHASES.SOURCE_READY, PHASES.TARGET_READY, PHASES.MAPPING_DRAFT, PHASES.MAPPING_VALID, PHASES.RUNNING, PHASES.COMPLETE]) {
    job = transition(job, phase);
  }
  assert.equal(job.phase, PHASES.COMPLETE);
});

test('CSV parser handles quoted commas, quotes, and CRLF', () => {
  const csv = 'name,note\r\n"Ada, A.","said ""hello"""\r\n';
  const parsed = parseCsv(csv);
  assert.deepEqual(parsed.headers, ['name', 'note']);
  assert.equal(parsed.rows[0].name, 'Ada, A.');
  assert.equal(parsed.rows[0].note, 'said "hello"');
});

test('schema inference distinguishes integer, number, boolean, date and string', () => {
  const schema = inferSchema([
    { a: '1', b: '1.25', c: 'true', d: '2026-09-04', e: 'x' },
    { a: '2', b: '2.50', c: 'false', d: '2026-09-05', e: 'y' }
  ]);
  assert.deepEqual(Object.fromEntries(schema.map(f => [f.name, f.type])), {
    a: 'integer', b: 'number', c: 'boolean', d: 'date', e: 'string'
  });
});

test('fingerprint is stable and sensitive', async () => {
  const a = await fingerprintText('abc');
  const b = await fingerprintText('abc');
  const c = await fingerprintText('abd');
  assert.equal(a, b);
  assert.notEqual(a, c);
});
