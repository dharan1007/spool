#!/usr/bin/env node
/**
 * Actions-free candidate qualification. Deliberately not a publish/deploy tool.
 * A successful build is NOT production authorization until the mandatory
 * browser, SQLite and connector-denial evidence gates have run on this SHA.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, sep, dirname } from 'node:path';
import { join } from 'node:path';
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;

function assertCleanSource(sha) {
  if (git(['rev-parse', 'HEAD']).toLowerCase() !== sha) throw new Error('Source HEAD changed during candidate qualification');
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Tracked source changed during candidate qualification');
}
const browserPython = process.env.SPOOL_BROWSER_PYTHON?.trim() || (process.platform === 'win32' ? 'py' : 'python3');
const browserArgs = process.platform === 'win32' && browserPython.toLowerCase() === 'py' ? ['-3'] : [];
const REQUIRED_REAL_SURFACES = Object.freeze([
  { id: 'browser_ui', command: [browserPython, ...browserArgs, 'scripts/qualify-browser-ui.py'], source: 'scripts/qualify-browser-ui.py' },
  { id: 'sqlite_sustained', command: ['node', 'scripts/qualify-sqlite-production.js'], source: 'scripts/qualify-sqlite-production.js' },
  { id: 'production_denial', command: ['node', '--test', '--test-reporter=tap', 'tests/production-connector-policy.test.js'], source: 'tests/production-connector-policy.test.js' }
]);
const CHECKS = Object.freeze([
  { id: 'dependency_install', command: ['npm', 'ci'] },
  { id: 'full_suite', command: ['npm', 'test'] },
  { id: 'required_sqlite_suite', command: ['node', '--test', '--test-reporter=tap', '--test-concurrency=1',
    'tests/sqlite-target.test.js', 'tests/sqlite-preflight.test.js', 'tests/conformance/sqlite-conformance.test.js',
    'tests/conformance/sqlite-faults.test.js', 'tests/crash-recovery.test.js', 'tests/fencing.test.js',
    'tests/source-snapshot-streaming.test.js', 'tests/snapshot-permissions.test.js'] },
  { id: 'build', command: ['npm', 'run', 'build'] },
  { id: 'benchmark', command: ['npm', 'run', 'benchmark'] },
  { id: 'static', command: ['node', 'scripts/static-check.js'] },
  { id: 'model', command: ['node', 'scripts/check-svmp-model.js'] },
  { id: 'package', command: ['npm', 'run', 'pack:verify'] },
  { id: 'release_chain', command: ['node', 'scripts/release-gate.js'] }
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}
function outputName(id) {
  return id.replace(/[^a-z0-9_-]/g, '_');
}
export function testCounters(output) {
  const parsed = {};
  for (const [, key, value] of output.matchAll(/^# (tests|pass|fail|skipped|cancelled|todo) (\d+)\s*$/gm)) {
    parsed[key] = Number(value);
  }
  return Object.keys(parsed).length ? parsed : null;
}

export function assertPassingTestCounters(counters, { allowSkips = false } = {}) {
  const keys = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'];
  if (!counters || keys.some(key => !Number.isSafeInteger(counters[key]) || counters[key] < 0) ||
      counters.tests < 1 || counters.pass < 1 || counters.fail !== 0 ||
      counters.cancelled !== 0 || counters.todo !== 0 || (!allowSkips && counters.skipped !== 0) ||
      counters.tests !== counters.pass + counters.fail + counters.skipped + counters.cancelled + counters.todo) {
    throw new Error('Executed test counters are incomplete, inconsistent or contain required failures/skips');
  }
  return true;
}

export function validateSigningMaterial(privateKey, publicKeyPath) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Release signing requires an Ed25519 PEM private key');
  const enrolled = createPublicKey(readFileSync(publicKeyPath, 'utf8'));
  const derived = createPublicKey(key);
  const options = { type: 'spki', format: 'der' };
  if (!derived.export(options).equals(enrolled.export(options))) throw new Error('Private release key does not match enrolled public trust root');
}
export function assertInstalledPackageEvidence(payload, { sha, evidence }) {
  if (!payload || payload.installedSameRetainedArtifact !== true ||
      payload.retainedAfterVerification !== true ||
      payload.releaseCommit !== sha ||
      !/^[a-f0-9]{64}$/.test(payload.tarballSha256) ||
      typeof payload.tarballPath !== 'string') {
    throw new Error('Retained installed package identity is incomplete');
  }
  const retainedPath = resolve(payload.tarballPath);
  const trustedRoot = resolve(evidence, 'packages');
  if (!retainedPath.startsWith(trustedRoot + sep)) throw new Error('Tested package escaped qualification evidence directory');
  if (!existsSync(retainedPath)) throw new Error('Retained installed package is missing');
  if (sha256(readFileSync(retainedPath)) !== payload.tarballSha256) throw new Error('Retained installed package digest differs from attested artifact');
  return true;
}

function runCheck(check, root) {
  const [tool, ...args] = check.command;
  const result = spawnSync(tool, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32' && tool === 'npm',
    env: {
      ...process.env,
      SPOOL_COMMIT_SHA: root.sha,
      EXPECTED_SHA: root.sha,
      SPOOL_BENCHMARK_OUTPUT_DIR: join(root.evidence, 'benchmarks'),
      SPOOL_PACKAGE_EVIDENCE_DIR: join(root.evidence, 'packages'),
      ...(check.env || {})
    }
  });
  const output = (result.stdout || '') + '\n' + (result.stderr || '');
  const log = join(root.evidence, outputName(check.id) + '.log');
  writeFileSync(log, output, 'utf8');
  const counters = testCounters(output);
  let reason = result.error ? result.error.message : result.status !== 0 ? 'nonzero_exit' : null;
  if (['full_suite', 'required_sqlite_suite', 'production_denial'].includes(check.id)) {
    try { assertPassingTestCounters(counters, { allowSkips: check.id === 'full_suite' }); }
    catch (error) { reason ||= (check.id === 'required_sqlite_suite' ? 'required_sqlite_skip_or_failure' : 'invalid_execution_counts') + ': ' + error.message; }
  }
  // Qualifying a drifting source tree invalidates the exact-source evidence chain.
  try { assertCleanSource(root.sha); }
  catch (error) { reason ||= 'source_drift: ' + error.message; }
  let attested = null;
  if (check.id === 'package') {
    const tag = (result.stdout || '').lastIndexOf('"installedSameRetainedArtifact"');
    if (tag < 0) reason ||= 'package_identity_not_reported';
    else {
      try {
        const payload = JSON.parse((result.stdout || '').slice((result.stdout || '').lastIndexOf('{')));
        assertInstalledPackageEvidence(payload, root);
      } catch {
        reason ||= 'package_identity_invalid';
      }
    }
  }
  if (check.realSurface) {
    if (check.id === 'production_denial' && (!counters || counters.tests < 1 || counters.fail !== 0 || counters.skipped !== 0 || counters.cancelled !== 0 || counters.todo !== 0)) reason ||= 'production_denial_execution_counts_missing_or_failed';
    const markers = (result.stdout || '').split(/\r?\n/).map(line => line.replace(/^# /, '')).filter(line => line.startsWith('SPOOL_EVIDENCE_JSON='));
    if (markers.length !== 1) reason ||= 'mandatory_evidence_marker_missing_or_duplicated';
    else {
      try { attested = JSON.parse(markers[0].slice('SPOOL_EVIDENCE_JSON='.length)); }
      catch { reason ||= 'malformed_mandatory_evidence'; }
    }
  }
  return {
    id: check.id,
    command: check.command,
    status: reason ? 'FAIL' : 'PASS',
    reason,
    exit: result.status,
    testCounts: counters,
    attested,
    logSha256: sha256(Buffer.from(output, 'utf8')),
    log
  };
}

export function assertSignedVerificationReceipt(payload, { sha, version, artifactRootSha256 }) {
  if (!payload || payload.pass !== true || payload.signatureVerified !== true ||
      payload.commit !== sha || payload.version !== version ||
      payload.artifactRootSha256 !== artifactRootSha256 ||
      !/^[a-f0-9]{64}$/.test(payload.artifactRootSha256) ||
      typeof payload.key !== 'string' || !/^ed25519:fpr:[a-f0-9]{64}$/.test(payload.key)) {
    throw new Error('Actual enrolled-key signature verification or immutable release identity is missing');
  }
  return true;
}

/**
 * Give every invocation its own evidence directory, even for an unchanged SHA.
 * Reusing the SHA directory let two independent gate runs overwrite one
 * another's logs, package artifacts and signatures, destroying provenance.
 */
export function qualificationEvidenceDirectory({ checkout, evidenceRoot, sha, attemptId = randomUUID() }) {
  if (!SHA.test(sha) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)) {
    throw new Error('Qualification evidence requires an exact commit SHA and random attempt UUID');
  }
  const source = resolve(checkout);
  const evidence = resolve(evidenceRoot, 'bounded-qualification', sha, attemptId);
  if (evidence === source || evidence.startsWith(source + sep)) {
    throw new Error('Qualification evidence must be stored outside the source checkout');
  }
  return evidence;
}

export function qualificationPlan() {
  return Object.freeze({ actionsFree: true, commands: CHECKS, requiredRealSurfaces: REQUIRED_REAL_SURFACES });
}

export function candidatePreflight() {
  const current = git(['rev-parse', 'HEAD']).toLowerCase();
  if (!SHA.test(current)) throw new Error('release qualification requires an exact Git HEAD SHA');
  const expected = process.env.SPOOL_COMMIT_SHA || current;
  if (!SHA.test(expected) || expected !== current) throw new Error('SPOOL_COMMIT_SHA does not match checked-out HEAD');
  // Ignore untracked cache/build artifacts, not edits to tracked source.
  assertCleanSource(current);
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  if (!version) throw new Error('package.json version missing');
  return Object.freeze({ sha: current, version });
}

export function validateBoundEvidence(value, sha, id, expectedLogSha256 = null) {
  if (!value || value.status !== 'PASS' || value.commitSha !== sha || value.surface !== id ||
      value.actualExecution !== true || !Number.isInteger(value.assertions) || value.assertions < 1 ||
      (expectedLogSha256 !== null && value.logSha256 !== expectedLogSha256)) {
    throw new Error(id + ': mandatory executed qualification evidence is missing or not bound to this commit');
  }
}

export function qualify() {
  const identity = candidatePreflight();
  const checkout = resolve('.');
  const evidenceRoot = resolve(process.env.SPOOL_QUALIFICATION_EVIDENCE_ROOT?.trim() || join(checkout, '..', 'evidence'));
  const evidence = qualificationEvidenceDirectory({ checkout, evidenceRoot, sha: identity.sha });
  // Keep logs, benchmark products and the exact installed tarball external.
  // Build outputs under dist are excluded from committed source, but tracked files
  // must remain unmodified after every command.
  mkdirSync(dirname(evidence), { recursive: true });
  mkdirSync(evidence); // Exclusive create: concurrent runs must never share an attempt directory.
  const root = { ...identity, evidence };
  const signedEvidence = resolve(process.env.SPOOL_PARITY_EVIDENCE?.trim() || join(evidence, 'parity-evidence.json'));
  if (signedEvidence === checkout || signedEvidence.startsWith(checkout + sep)) throw new Error('Signed release evidence must remain outside the source checkout');
  const entries = [];
  const reportPath = join(evidence, 'qualification.json');
  function persist() {
    const passing = entries.every(e => e.status === 'PASS');
    const report = {
      schemaVersion: 1, commitSha: root.sha, packageVersion: root.version,
      status: passing && entries.length === CHECKS.length + REQUIRED_REAL_SURFACES.length + 2 ? 'PASS' : 'BLOCKED',
      entries
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    return report;
  }
  try {
    const installation = runCheck(CHECKS[0], root);
    entries.push(installation);
    persist();
    if (installation.status !== 'PASS') throw new Error('Pinned dependency installation failed; see installation log');
    const audit = runCheck({
      id: 'security_audit', command: ['npm', 'audit', '--omit=dev', '--audit-level=high', '--json']
    }, root);
    entries.push(audit);
    persist();
    if (audit.status !== 'PASS') throw new Error('High/critical dependency audit failed; see audit log');

    for (const check of CHECKS.slice(1)) {
      const item = runCheck(check.id === 'release_chain'
        ? { ...check, env: { SPOOL_PARITY_EVIDENCE: signedEvidence } } : check, root);
      entries.push(item);
      persist();
      if (item.status !== 'PASS') throw new Error(check.id + ': failed, see ' + item.log);
    }
    for (const surface of REQUIRED_REAL_SURFACES) {
      if (!existsSync(surface.source)) {
        entries.push({ id: surface.id, status: 'NOT_EXECUTED', reason: 'required_runner_not_implemented' });
        persist();
        throw new Error(surface.id + ': required executable gate is not implemented');
      }
      const item = runCheck({ ...surface, realSurface: true }, root);
      entries.push(item);
      persist();
      if (item.status !== 'PASS') throw new Error(surface.id + ': real qualification failed');
      const evidencePath = join(evidence, surface.id + '.json');
      const boundEvidence = { ...item.attested, logSha256: item.logSha256 };
      validateBoundEvidence(boundEvidence, root.sha, surface.id, item.logSha256);
      writeFileSync(evidencePath, JSON.stringify(boundEvidence, null, 2) + '\n', 'utf8');
    }
    const privateKey = process.env.SPOOL_RELEASE_PRIVATE_KEY?.trim();
    const publicKey = process.env.SPOOL_RELEASE_PUBLIC_KEY?.trim() || 'keys/release-public.key';
    if (!privateKey || !existsSync(publicKey) || !existsSync(signedEvidence)) {
      entries.push({ id: 'signed_provenance', status: 'NOT_EXECUTED', reason: 'release_keys_or_parity_evidence_missing' });
      persist();
      throw new Error('Ed25519 release signature, keys or parity evidence missing');
    }
    validateSigningMaterial(privateKey, publicKey);
    // The earlier release_chain job may have signed the candidate, but it ran
    // BEFORE the real Chrome/SQLite jobs. Verify actual signed bytes again
    // after all mandatory surfaces, not just a key match or file existence.
    const signed = runCheck({
      id: 'signed_provenance_verify',
      command: ['node', 'scripts/verify-release-chain.js'],
      env: { SPOOL_PARITY_EVIDENCE: signedEvidence, SPOOL_RELEASE_PUBLIC_KEY: publicKey }
    }, root);
    if (signed.status !== 'PASS') {
      entries.push({ id: 'signed_provenance', status: 'FAIL', reason: 'cryptographic_verification_failed', log: signed.log });
      persist();
      throw new Error('Ed25519 enrolled-key signature verification failed; see ' + signed.log);
    }
    let receipt;
    try {
      const lines = readFileSync(signed.log, 'utf8').split(/\r?\n/).filter(Boolean);
      if (lines.length !== 1) throw new Error('Signature verifier must emit one result');
      receipt = JSON.parse(lines[0]);
      const release = JSON.parse(readFileSync('dist/release.json', 'utf8'));
      assertSignedVerificationReceipt(receipt, {
        sha: root.sha, version: root.version,
        artifactRootSha256: release.artifactRootSha256
      });
    } catch (error) {
      entries.push({ id: 'signed_provenance', status: 'FAIL', reason: error.message, log: signed.log });
      persist();
      throw new Error('Signed release receipt is not valid: ' + error.message);
    }
    entries.push({ id: 'signed_provenance', status: 'PASS', signatureVerified: true,
      evidencePath: signedEvidence,
      commitSha: root.sha, version: root.version, key: receipt.key,
      artifactRootSha256: receipt.artifactRootSha256,
      log: signed.log, logSha256: signed.logSha256 });
  } catch (error) {
    persist();
    process.stderr.write('SPOOL production candidate BLOCKED: ' + error.message + '\nEvidence: ' + reportPath + '\n');
    return 1;
  }
  persist();
  process.stdout.write('SPOOL bounded candidate PASS (not production deployed): ' + root.sha + '\nEvidence: ' + reportPath + '\n');
  return 0;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invoked === import.meta.url) {
  if (process.argv.includes('--plan')) process.stdout.write(JSON.stringify(qualificationPlan(), null, 2) + '\n');
  else process.exitCode = qualify();
}
