import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Local Runner surface exposes the released install and full installed-CLI lifecycle', async () => {
  const source = await readFile('src/product-surface.js', 'utf8');
  assert.match(source, /npm install -g github:dharan1007\/spool#v1\.0\.0/);
  assert.match(source, /releases\/tag\/v1\.0\.0/);
  for (const command of ['spool inspect', 'spool plan', 'spool dry-run', 'spool approve', 'spool run', 'spool status', 'spool verify', 'spool receipt']) {
    assert.ok(source.includes(command), `Local Runner page must show ${command}`);
  }
  assert.match(source, /Browser Studio stays capped at 50 MiB/i);
  assert.match(source, /256 MiB/i);
  assert.match(source, /customer-controlled machine/i);
  assert.match(source, /Hobby/i);
  assert.doesNotMatch(source, /paid checkout/i);
});
