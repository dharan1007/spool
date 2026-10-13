import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanProductionPurity, allowlistedPurity, stalePurityAllowlist } from '../scripts/production-purity.js';

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'spool-purity-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = join(root, relative);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

test('purity scanner detects banned notes, stubs, fakes and hardcoded outputs', async () => {
  const root = await fixture({
    'src/a.js': 'export const x = 1;\n// TODO: finish this\n',
    'src/b.js': 'throw new NotImplementedError();\nconst dummy = fetchMockResult();\n',
    'src/c.js': 'const answer = hardcoded_output_for_test_1;\nconst branch = demo_only_path;\n'
  });
  try {
    const report = await scanProductionPurity({ root });
    const patterns = report.violations.map(hit => hit.pattern).sort();
    assert.deepEqual(patterns, ['banned-note', 'demo-only', 'dummy-data', 'hardcoded-output', 'mock-result', 'not-implemented']);
    assert.equal(report.ok, false);
    assert.ok(report.uncovered.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('purity scanner flags swallowed errors without rethrow and silent fallbacks', async () => {
  const root = await fixture({
    'src/daemon/work.js': 'async function run() {\n  try {\n    await mutate();\n  } catch {\n    return true;\n  }\n}\n',
    'src/execution/plan.js': 'const rows = input.rows || fallbackRows;\n'
  });
  try {
    const report = await scanProductionPurity({ root });
    assert.deepEqual(report.violations.map(hit => `${hit.file}:${hit.pattern}`).sort(), [
      'src/daemon/work.js:catch-all-success',
      'src/execution/plan.js:silent-fallback'
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('purity scanner accepts narrow error mapping with rethrow and passes the clean tree', async () => {
  const root = await fixture({
    'src/daemon/work.js': 'async function run() {\n  try {\n    await mutate();\n  } catch (error) {\n    if (error?.code === 1792) return true;\n    throw error;\n  }\n}\n'
  });
  try {
    const report = await scanProductionPurity({ root });
    assert.deepEqual(report.violations, []);
    assert.equal(report.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const tree = await scanProductionPurity({});
  assert.equal(tree.ok, true);
  assert.equal(stalePurityAllowlist(tree.violations).length, 0);
  assert.ok(tree.filesScanned > 50);
  for (const entry of allowlistedPurity()) {
    assert.ok(entry.justification.length > 20, `allowlist entry needs a real justification: ${entry.file}`);
  }
});

test('purity scanner classifies actual timers, not quoted timer signatures in its rules', async () => {
  const root = await fixture({
    'src/timers.js': [
      "const literal = 'window.setTimeout(() => {}, 10)';",
      'window.setTimeout(() => {}, 10);',
      '// setTimeout(() => {}, 10);'
    ].join('\n') + '\n'
  });
  try {
    const report = await scanProductionPurity({ root });
    const timers = report.violations.filter(hit => hit.pattern === 'sleep-sync');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].line, 2);
    assert.equal(report.ok, false, 'unknown executable timer must still fail the gate');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('XLSX worker timeout is narrowly allowlisted and still fails closed', async () => {
  const root = await fixture({
    'src/xlsx-worker-client.js': "timer = setTimeout(() => finish(new Error('XLSX background processing exceeded its 5-minute safety limit.')), timeoutMs);\n"
  });
  try {
    const report = await scanProductionPurity({ root });
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].pattern, 'sleep-sync');
    assert.equal(report.ok, true);
    const unknown = await fixture({ 'src/unknown.js': 'setTimeout(() => grantSuccess(), 5000);\n' });
    try {
      const unknownReport = await scanProductionPurity({ root: unknown });
      assert.equal(unknownReport.ok, false);
      assert.equal(unknownReport.uncovered.length, 1);
    } finally {
      await rm(unknown, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});