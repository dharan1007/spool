import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('primary CI workflow dispatches immutable release publication through a dedicated script', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release:/);
  assert.match(workflow, /type:\s*boolean/);
  assert.match(workflow, /commit_sha:/);
  assert.match(workflow, /type:\s*string/);
  assert.match(workflow, /version:/);
  assert.match(workflow, /publish-release/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /scripts\/publish-release\.sh/);
});

test('release publication script proves protected main and creates immutable verifiable assets', async () => {
  const script = await readFile('scripts/publish-release.sh', 'utf8');
  assert.match(script, /refs\/heads\/main/);
  assert.match(script, /origin\/main/);
  assert.match(script, /npm run check/);
  assert.match(script, /npm run pack:verify/);
  assert.match(script, /npm pack/);
  assert.match(script, /SHA256SUMS/);
  assert.match(script, /release-record\.json/);
  assert.match(script, /gh release create/);
  assert.match(script, /gh release download/);
  assert.doesNotMatch(script, /--clobber/);
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
