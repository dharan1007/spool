import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResourceSummary } from '../src/platform/measurement-evidence.js';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-measurement-evidence-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('missing resource summary is reported, not thrown', () => withDir(async dir => {
  const result = await readResourceSummary(join(dir, 'resource-summary.json'));
  assert.equal(result.ok, false);
  assert.match(result.failure, /^resource summary unavailable: ENOENT$/);
}));

test('zero samples cannot satisfy qualification', () => withDir(async dir => {
  const path = join(dir, 'resource-summary.json');
  await writeFile(path, JSON.stringify({ samples: 0, errors: [] }));
  const result = await readResourceSummary(path);
  assert.equal(result.ok, false);
  assert.equal(result.failure, 'missing samples or measurement errors');
}));

test('recorded measurement errors cannot satisfy qualification', () => withDir(async dir => {
  const path = join(dir, 'resource-summary.json');
  await writeFile(path, JSON.stringify({ samples: 4, peakTreeWorkingSetBytes: 1024, errors: ['[Errno 2]'] }));
  const result = await readResourceSummary(path);
  assert.equal(result.ok, false);
  assert.equal(result.summary.samples, 4);
}));

test('malformed resource summary is reported, not thrown', () => withDir(async dir => {
  const path = join(dir, 'resource-summary.json');
  await writeFile(path, JSON.stringify({ samples: 'many' }));
  const result = await readResourceSummary(path);
  assert.equal(result.ok, false);
  assert.equal(result.failure, 'resource summary has invalid shape');
}));

test('valid resource summary is accepted verbatim', () => withDir(async dir => {
  const path = join(dir, 'resource-summary.json');
  const summary = { samples: 12, peakTreeWorkingSetBytes: 2048, errors: [] };
  await writeFile(path, JSON.stringify(summary));
  const result = await readResourceSummary(path);
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, summary);
}));
