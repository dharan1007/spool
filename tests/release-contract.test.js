import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const artifacts = ['.github/workflows/ci.yml', 'SECURITY.md', 'docs/DEMO_SCRIPT.md'];

test('release includes CI, security policy, and evaluator demo script', async () => {
  for (const file of artifacts) {
    const info = await stat(new URL(`../${file}`, import.meta.url));
    assert.ok(info.isFile() && info.size > 100, `${file} missing or too small`);
  }
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /npm run check/);
});
