#!/usr/bin/env node
// Independent evidence verification for an industrial-postgres run directory.
// Every check is derived from the directory itself plus the required-scenario
// manifest — nothing is trusted on the manifest's word alone:
//   1. sha256sums.txt pins every file's contents (except itself).
//   2. The directory file set (minus sha256sums.txt) exactly equals the
//      manifest's pinned set: no added, removed, or renamed files.
//   3. Manifest schema version is supported (v2: set-pinning, no embedded
//      sums, per-scenario status, stub count).
//   4. failures.json is consistent with the manifest summary.
//   5. The manifest result follows from the failures (PASS only with zero
//      unexpected failures and a complete scenario set; releaseGrade only on
//      PASS with a clean tree).
//   6. Every required scenario reported a terminal status; no stubs recorded.
import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { verifySha256Sums } from './checksums.js';
import { requiredScenarioNames } from './scenarios.js';

function fail(message) {
  console.error(`Evidence verification failed: ${message}`);
  process.exit(1);
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node scripts/qualify/verify-evidence.js <run-dir>');
    process.exit(2);
  }

  // 1. Contents.
  try {
    await verifySha256Sums(dir);
  } catch (e) {
    fail(e.message);
  }

  // 2. File set equality.
  const onDisk = (await readdir(dir)).filter(file => file !== 'sha256sums.txt').sort();
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch (e) {
    fail(`manifest.json is missing or invalid: ${e.message}`);
  }
  if (manifest.schemaVersion !== 2) fail(`unsupported manifest schemaVersion ${manifest.schemaVersion}; expected 2`);
  const pinned = Array.isArray(manifest.evidence?.files) ? [...manifest.evidence.files].sort() : null;
  if (!pinned || pinned.length !== onDisk.length || pinned.some((file, index) => file !== onDisk[index])) {
    fail(`file set mismatch: on disk [${onDisk.join(', ')}] vs manifest [${(pinned ?? []).join(', ')}]`);
  }

  // 3. Failures consistency.
  let failures;
  try {
    failures = JSON.parse(await readFile(join(dir, 'failures.json'), 'utf8'));
  } catch (e) {
    fail(`failures.json is missing or invalid: ${e.message}`);
  }
  if (!Array.isArray(failures)) fail('failures.json is not an array');
  const summary = manifest.summary ?? {};
  if (failures.length !== summary.failures) {
    fail(`failures.json has ${failures.length} entries but manifest summary claims ${summary.failures}`);
  }
  const unexpected = failures.filter(f => f?.classification !== 'EXPECTED_REFUSAL' && f?.expected === false);
  if (unexpected.length !== summary.unexpectedFailures) {
    fail(`unexpected failure count ${unexpected.length} disagrees with manifest summary ${summary.unexpectedFailures}`);
  }

  // 4. Required scenarios.
  const scenarios = manifest.scenarios ?? {};
  const missing = [];
  const nonTerminal = [];
  for (const name of requiredScenarioNames()) {
    const status = scenarios[name];
    if (status == null) missing.push(name);
    else if (status !== 'PASS' && status !== 'FAIL') nonTerminal.push(`${name}=${status}`);
  }
  if (missing.length) fail(`required scenarios missing from manifest: ${missing.join(', ')}`);
  if (nonTerminal.length) fail(`required scenarios without terminal status: ${nonTerminal.join(', ')}`);

  // 5. Stubs never pass.
  if ((summary.stubs ?? 0) !== 0) fail(`manifest records ${summary.stubs} stub events; stubs never pass`);

  // 6. Result follows from evidence.
  const complete = missing.length === 0 && nonTerminal.length === 0;
  if (manifest.result === 'PASS') {
    if (unexpected.length !== 0) fail('result PASS with unexpected failures present');
    if (!complete) fail('result PASS with an incomplete scenario set');
  } else if (manifest.result === 'FAIL') {
    if (unexpected.length === 0 && complete) fail('result FAIL with no unexpected failures and a complete set');
  } else if (manifest.result === 'INCOMPLETE') {
    if (complete && unexpected.length === 0) fail('result INCOMPLETE with a complete set and no unexpected failures');
  } else {
    fail(`unknown manifest result ${manifest.result}`);
  }
  if (manifest.releaseGrade === true && (manifest.result !== 'PASS' || manifest.dirty === true)) {
    fail('releaseGrade=true requires result PASS on a clean tree');
  }

  console.log(`Evidence verified: ${dir}`);
  console.log(`Run: ${manifest.qualificationRunId} Profile: ${manifest.profile} Result: ${manifest.result}`);
  console.log(`Files: ${pinned.length} Checksums: OK Scenarios: ${requiredScenarioNames().length} Failures: ${failures.length} (unexpected: ${unexpected.length})`);
  if (manifest.dirty) console.log(`Warning: dirty worktree, releaseGrade=false`);
  process.exit(0);
}

main().catch(e => fail(e.message));
