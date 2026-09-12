import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const artifacts = ['.github/workflows/ci.yml', 'SECURITY.md', 'docs/DEMO_SCRIPT.md', 'scripts/browser-smoke.py'];

test('release includes CI, security policy, evaluator demo script, and browser smoke harness', async () => {
  for (const file of artifacts) {
    const info = await stat(new URL(`../${file}`, import.meta.url));
    assert.ok(info.isFile() && info.size > 100, `${file} missing or too small`);
  }
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /browser-smoke\.py/);
  assert.match(workflow, /SPOOL_SERVE_DIR:\s*dist/);
});

test('production smoke cryptographically verifies deployed artifact bytes before browser smoke', async () => {
  const workflow = await readFile(new URL('../.github/workflows/production-smoke.yml', import.meta.url), 'utf8');
  assert.match(workflow, /scripts\/verify-deployed-release\.js/);
  assert.match(workflow, /EXPECTED_SHA:/);
  assert.match(workflow, /SPOOL_URL:/);
  assert.match(workflow, /Run production browser smoke/);
  assert.ok(
    workflow.indexOf('verify-deployed-release.js') < workflow.indexOf('Run production browser smoke'),
    'artifact verification must execute before browser smoke'
  );
  assert.doesNotMatch(workflow, /urllib\.request|json\.load\(response\)/, 'commit-only inline verifier must be removed');
});
