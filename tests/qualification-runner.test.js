import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testCounters, validateSigningMaterial } from '../scripts/qualify-bounded-release.js';

test('qualification counters preserve real executed pass, failure and skip totals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-gate-counters-'));
  try {
    const path = join(root, 'counts.test.mjs');
    await writeFile(path, "import test from 'node:test'; import assert from 'node:assert/strict';\ntest('passing assertion',()=>assert.equal(1,1));\ntest('deliberate fault',()=>assert.equal(1,2));\ntest('explicit skipped case',{skip:true},()=>{});\n");
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path], { encoding: 'utf8', env });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.deepEqual(testCounters(run.stdout), { tests: 3, pass: 1, fail: 1, cancelled: 0, skipped: 1, todo: 0 });
    assert.equal(testCounters(''), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release signing accepts actual PEM material only for its enrolled Ed25519 public key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-gate-signing-'));
  try {
    const encoding = { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } };
    const enrolled = generateKeyPairSync('ed25519', encoding);
    const other = generateKeyPairSync('ed25519', encoding);
    const publicPath = join(root, 'public.pem');
    await writeFile(publicPath, enrolled.publicKey);
    assert.doesNotThrow(() => validateSigningMaterial(enrolled.privateKey, publicPath));
    assert.throws(() => validateSigningMaterial(other.privateKey, publicPath), /does not match/);
    assert.throws(() => validateSigningMaterial('malformed PEM', publicPath));
    assert.throws(() => validateSigningMaterial(enrolled.privateKey, join(root, 'missing.pem')), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
