import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('local manual release publishing runs strict qualification before any tag or GitHub release', async () => {
  const script = await readFile('scripts/publish-release.sh', 'utf8');
  assert.match(script, /git symbolic-ref HEAD/);
  assert.match(script, /refs\/heads\/main/);
  assert.match(script, /origin\/main/);
  assert.match(script, /SPOOL_COMMIT_SHA="\$COMMIT".*node scripts\/qualify-bounded-release\.js/);
  assert.match(script, /npm ci/);
  assert.ok(script.indexOf('node scripts/qualify-bounded-release.js') < script.indexOf('git tag -a'));
  assert.ok(script.indexOf('node scripts/qualify-bounded-release.js') < script.indexOf('gh release create'));
  assert.match(script, /SHA256SUMS/);
  assert.match(script, /release-record\.json/);
  assert.doesNotMatch(script, /--clobber/);
  assert.doesNotMatch(script, /github-actions\[bot\]|workflow_dispatch/);
});

test('publication is bound to requested SHA and refuses tag rewriting', async () => {
  const script = await readFile('scripts/publish-release.sh', 'utf8');
  assert.match(script, /test "\$HEAD_SHA" = "\$COMMIT"/);
  assert.match(script, /test "\$MAIN_SHA" = "\$COMMIT"/);
  assert.match(script, /EXISTING_TAG_SHA/);
  assert.match(script, /git fetch origin/);
  assert.match(script, /gh release download/);
  assert.match(script, /gh release view/);
  assert.match(script, /--verify-tag/);
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
