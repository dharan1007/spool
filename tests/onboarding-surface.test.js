import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const product = await readFile(new URL('../src/product-surface.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../product.css', import.meta.url), 'utf8');

test('public onboarding gives three supported paths without treating hosted UI as a database API', () => {
  for (const path of ['/start', '/integrations', '/developers']) {
    assert.ok(app.includes("'" + path + "'"), 'missing main route ' + path);
    assert.ok(product.includes("'" + path + "'"), 'missing product route ' + path);
  }
  for (const phrase of ['Open the CSV Studio', 'See the local setup', 'Explore integration paths', 'no public database-write API', '/v1/command']) {
    assert.ok(product.includes(phrase), 'missing useful integration guidance: ' + phrase);
  }
});

test('raw CLI instructions are opt-in and published limitations are honest', () => {
  const disclosure = '<summary>Show command-line installation and execution steps</summary>';
  assert.ok(product.includes(disclosure));
  assert.ok(product.indexOf(disclosure) < product.indexOf('<pre># Preferred v1.1.1 install'));
  assert.doesNotMatch(product, /GATE B · PRODUCTION-VERIFIED/);
  assert.ok(product.includes('sustained-load qualification is still missing'));
  assert.ok(product.includes('not a remotely hosted SPOOL API'));
});

test('developer links resolve to source documentation and mobile nav remains accessible', () => {
  assert.ok(product.includes('href="${REPO}/blob/main/src/daemon/spoold.js"'));
  assert.ok(!product.includes('\\' + '${REPO}'));
  assert.match(styles, /\.start-paths/);
  assert.match(styles, /\.developer-details/);
  assert.match(styles, /\.guided-home-band/);
  assert.match(styles, /\.product-topbar \.primary-nav\{display:flex/);
});
