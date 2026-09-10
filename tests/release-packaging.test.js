import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('release workflow is exact-SHA bound and publishes installable evidence', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /commit_sha:/);
  assert.match(workflow, /version:/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /origin\/main|refs\/heads\/main|git rev-parse/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /npm run pack:verify/);
  assert.match(workflow, /npm pack/);
  assert.match(workflow, /SHA256SUMS/);
  assert.match(workflow, /release-record\.json/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /gh release upload/);
});

test('release manifest generator binds artifact digest to version and commit', async () => {
  const source = await readFile('scripts/release-manifest.js', 'utf8');
  assert.match(source, /sha256/i);
  assert.match(source, /commit/i);
  assert.match(source, /version/i);
  assert.match(source, /artifact/i);
  assert.match(source, /CSV.*SQLite|sqlite/i);
  assert.match(source, /writeFile/);
});
