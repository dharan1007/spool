import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('Unified site exposes the current Local Runner release and full installed-CLI lifecycle', async () => {
  const [source, pkgText] = await Promise.all([
    readFile('src/site-content.js', 'utf8'),
    readFile('package.json', 'utf8')
  ]);
  const version = JSON.parse(pkgText).version;
  const escapedVersion = escapeRegex(version);
  assert.match(source, new RegExp(`npm install -g github:dharan1007/spool#v${escapedVersion}`));
  assert.match(source, new RegExp(`const RELEASE = 'v${escapedVersion}'`));
  assert.match(source, /REPO \+ '\/releases\/tag\/' \+ RELEASE/);
  for (const command of ['spool inspect', 'spool plan', 'spool dry-run', 'spool approve', 'spool run', 'spool status', 'spool verify', 'spool receipt']) {
    assert.ok(source.includes(command), `Local Runner page must show ${command}`);
  }
  assert.match(source, /Browser Studio stays capped at 50 MiB/i);
  assert.match(source, /256 MiB/i);
  assert.match(source, /customer-controlled machine/i);
  assert.match(source, /Cloudflare Pages/i);
  assert.doesNotMatch(source, /paid checkout/i);
});
