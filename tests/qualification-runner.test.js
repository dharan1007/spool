import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPassingTestCounters, testCounters, validateSigningMaterial, assertInstalledPackageEvidence, qualificationPlan } from '../scripts/qualify-bounded-release.js';

test('mandatory SQLite gate executes snapshot creation and privacy regressions without optional skips', () => {
  const suite = qualificationPlan().commands.find(item => item.id === 'required_sqlite_suite');
  assert.ok(suite.command.includes('tests/source-snapshot-streaming.test.js'));
  assert.ok(suite.command.includes('tests/snapshot-permissions.test.js'));
});

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

test('candidate qualification binds the installed CLI to the exact retained package bytes', async () => {
  const evidence = await mkdtemp(join(tmpdir(), 'spool-packed-evidence-'));
  const outside = await mkdtemp(join(tmpdir(), 'spool-outside-artifact-'));
  try {
    const packages = join(evidence, 'packages');
    await mkdir(packages);
    const path = join(packages, 'spool-test.tgz');
    const original = Buffer.from('actual installed tarball fixture bytes');
    await writeFile(path, original);
    const sha = 'a'.repeat(40);
    const digest = createHash('sha256').update(original).digest('hex');
    const report = { tarballPath: path, tarballSha256: digest, installedSameRetainedArtifact: true, retainedAfterVerification: true, releaseCommit: sha };
    assert.equal(assertInstalledPackageEvidence(report, { sha, evidence }), true);
    assert.throws(() => assertInstalledPackageEvidence({ ...report, installedSameRetainedArtifact: false }, { sha, evidence }), /incomplete/);
    assert.throws(() => assertInstalledPackageEvidence({ ...report, releaseCommit: 'b'.repeat(40) }, { sha, evidence }), /incomplete/);
    const outsider = join(outside, 'spool-test.tgz');
    await writeFile(outsider, original);
    assert.throws(() => assertInstalledPackageEvidence({ ...report, tarballPath: outsider }, { sha, evidence }), /escaped/);
    await writeFile(path, Buffer.from('tampered installed bytes'));
    assert.throws(() => assertInstalledPackageEvidence(report, { sha, evidence }), /digest differs/);
  } finally {
    await rm(evidence, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('candidate preflight rejects actual tracked-source drift and mismatched HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-gate-source-'));
  try {
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=', ...args], { cwd: root, encoding: 'utf8' }).trim();
    git(['init', '--quiet']);
    await writeFile(join(root, 'package.json'), '{"version":"1.1.1"}\n');
    git(['add', 'package.json']);
    git(['-c', 'user.name=Qualification test', '-c', 'user.email=qualification@example.invalid', 'commit', '--quiet', '-m', 'isolated qualification fixture']);
    const sha = git(['rev-parse', 'HEAD']);
    const moduleUrl = new URL('../scripts/qualify-bounded-release.js', import.meta.url).href;
    const invoke = extra => spawnSync(process.execPath, ['--input-type=module', '-e', 'const {candidatePreflight}=await import(process.env.SPOOL_GATE_MODULE); console.log(JSON.stringify(candidatePreflight()));'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, SPOOL_GATE_MODULE: moduleUrl, SPOOL_COMMIT_SHA: sha, ...extra }
    });
    const clean = invoke({});
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(JSON.parse(clean.stdout).sha, sha);
    assert.equal(invoke({ SPOOL_COMMIT_SHA: '0'.repeat(40) }).status, 1);
    await writeFile(join(root, 'package.json'), '{"version":"changed"}\n');
    const dirty = invoke({});
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /Tracked source changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('native qualification installs locked dependencies before auditing or executing suites', () => {
  const first = qualificationPlan().commands[0];
  assert.equal(first.id, 'dependency_install');
  assert.deepEqual(first.command, ['npm', 'ci']);
});

test('qualification rejects cancelled, TODO, absent and inconsistent execution totals', () => {
  const passing = { tests: 2, pass: 2, fail: 0, skipped: 0, cancelled: 0, todo: 0 };
  assert.equal(assertPassingTestCounters(passing), true);
  for (const counters of [null, { tests: 1, fail: 0 },
    { ...passing, tests: 3 }, { ...passing, pass: 1, cancelled: 1 },
    { ...passing, pass: 1, todo: 1 }, { ...passing, pass: 1, skipped: 1 },
    { ...passing, pass: 1, fail: 1 }]) {
    assert.throws(() => assertPassingTestCounters(counters), /counters/);
  }
  assert.equal(assertPassingTestCounters({ ...passing, pass: 1, skipped: 1 }, { allowSkips: true }), true);
  assert.throws(() => assertPassingTestCounters({ ...passing, pass: 1, cancelled: 1 }, { allowSkips: true }), /counters/);
});
