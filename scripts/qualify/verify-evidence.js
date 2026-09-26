#!/usr/bin/env node
// Independent evidence verification for an industrial-postgres run directory.
// Every check is derived from the directory itself plus the required-scenario
// manifest — nothing is trusted on the manifest's word alone:
//   1. sha256sums.txt pins every file's contents (except itself).
//   2. The directory file set (minus sha256sums.txt) exactly equals the
//      manifest's pinned set: no added, removed, or renamed files.
//   3. Manifest schema version is supported (v3: set-pinning plus
//      requested/effective anti-downscale enforcement; v4 additionally
//      separates release integrity from immutable INDUSTRIAL-scale proof).
//   4. failures.json is consistent with the manifest summary.
//   5. The manifest result follows from the failures (PASS only with zero
//      unexpected failures and a complete scenario set; releaseGrade only on
//      PASS with a clean tree; industrialScaleGrade only on a clean immutable
//      INDUSTRIAL-profile PASS).
//   6. Every required scenario reported a terminal status; no stubs recorded.
//   7. Requested configuration equals effective configuration for immutable
//      profile names (CI/SMALL/MEDIUM/LARGE/INDUSTRIAL): runs carrying a
//      larger profile name after silent downscaling are rejected. *_CUSTOM
//      runs must record both sides of the divergence.
//   8. Every scenario's recorded effectiveConfig matches the manifest
//      effectiveConfig on its declared profile keys (no per-scenario quiet
//      reduction hiding under a profile-wide match).
import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { verifySha256Sums } from './checksums.js';
import { REQUIRED_SCENARIOS, requiredScenarioNames, isExpectedRefusal, isUnexpectedFailure } from './scenarios.js';
import { PROFILE_DEFINITIONS, qualifiesIndustrialScale } from './profiles.js';

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
  if (![3, 4].includes(manifest.schemaVersion)) {
    fail(`unsupported manifest schemaVersion ${manifest.schemaVersion}; expected 3 or 4`);
  }
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
  const unexpected = failures.filter(isUnexpectedFailure);
  if (unexpected.length !== summary.unexpectedFailures) {
    fail(`unexpected failure count ${unexpected.length} disagrees with manifest summary ${summary.unexpectedFailures}`);
  }
  const expectedRefusals = failures.filter(isExpectedRefusal).length;
  if (expectedRefusals !== summary.expectedRefusals) {
    fail(`expected refusal count ${expectedRefusals} disagrees with manifest summary ${summary.expectedRefusals}`);
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
    if (requiredScenarioNames().some(name => scenarios[name] !== 'PASS')) {
      fail('result PASS with one or more failed required scenarios');
    }
  } else if (manifest.result === 'FAIL') {
    if (unexpected.length === 0 && complete) fail('result FAIL with no unexpected failures and a complete set');
  } else if (manifest.result === 'INCOMPLETE') {
    if (complete && unexpected.length === 0) fail('result INCOMPLETE with a complete set and no unexpected failures');
  } else {
    fail(`unknown manifest result ${manifest.result}`);
  }
  if (typeof manifest.releaseGrade !== 'boolean') fail('manifest releaseGrade must be boolean');
  if (manifest.releaseGrade === true && (manifest.result !== 'PASS' || manifest.dirty === true)) {
    fail('releaseGrade=true requires result PASS on a clean tree');
  }
  if (manifest.schemaVersion >= 4) {
    if (typeof manifest.industrialScaleGrade !== 'boolean') fail('v4 manifest industrialScaleGrade must be boolean');
    const expectedIndustrialScaleGrade = qualifiesIndustrialScale({
      result: manifest.result,
      dirty: manifest.dirty,
      profile: manifest.profile,
      requestedProfile: manifest.requestedProfile
    });
    if (manifest.industrialScaleGrade !== expectedIndustrialScaleGrade) {
      fail(`industrialScaleGrade=${manifest.industrialScaleGrade} is inconsistent with result/profile/tree; expected ${expectedIndustrialScaleGrade}`);
    }
  } else if (manifest.industrialScaleGrade != null) {
    fail('v3 evidence must not retroactively carry industrialScaleGrade; use schemaVersion 4');
  }

  // 7. Requested == effective for immutable names.
  const profileName = manifest.profile;
  const requested = manifest.requestedConfig ?? null;
  const effective = manifest.effectiveConfig ?? null;
  const isCustom = typeof profileName === 'string' && profileName.endsWith('_CUSTOM');
  if (!requested || typeof requested !== 'object' || !effective || typeof effective !== 'object') {
    fail('manifest must record requestedConfig and effectiveConfig');
  }
  if (!isCustom) {
    const definition = PROFILE_DEFINITIONS[profileName];
    if (!definition) fail(`unknown immutable profile ${profileName}`);
    for (const key of Object.keys(effective)) {
      if (key === 'name' || key === 'requestedProfile' || key === 'requestedConfig' || key === 'customized' || key === 'description') continue;
      if (effective[key] !== definition[key]) {
        fail(`immutable profile ${profileName} ran ${key}=${effective[key]} instead of declared ${definition[key]} (silent downscale)`);
      }
    }
    for (const key of Object.keys(requested)) {
      if (key === 'name' || key === 'requestedProfile' || key === 'requestedConfig' || key === 'customized' || key === 'description') continue;
      if (requested[key] !== definition[key]) {
        fail(`immutable profile ${profileName} requested ${key}=${requested[key]} instead of declared ${definition[key]}`);
      }
    }
  } else {
    const baseName = profileName.slice(0, -'_CUSTOM'.length);
    if (manifest.requestedProfile !== baseName) {
      fail(`custom profile ${profileName} must record requestedProfile=${baseName}`);
    }
    let diverges = false;
    for (const key of new Set([...Object.keys(requested), ...Object.keys(effective)])) {
      if (key === 'name' || key === 'requestedProfile' || key === 'requestedConfig' || key === 'customized' || key === 'description') continue;
      if (requested[key] !== effective[key]) diverges = true;
    }
    if (!diverges) fail(`custom profile ${profileName} records no divergence; use the immutable name`);
  }

  // 8. Per-scenario effectiveConfig matches the manifest effectiveConfig.
  let metrics;
  try {
    metrics = JSON.parse(await readFile(join(dir, 'metrics.json'), 'utf8'));
  } catch (e) {
    fail(`metrics.json is missing or invalid: ${e.message}`);
  }
  for (const entry of REQUIRED_SCENARIOS) {
    const scenarioMetrics = metrics[entry.name];
    if (!scenarioMetrics || typeof scenarioMetrics !== 'object') fail(`metrics for ${entry.name} are missing`);
    if (scenarioMetrics.status !== scenarios[entry.name]) {
      fail(`metrics status for ${entry.name} disagrees with manifest (${scenarioMetrics.status} vs ${scenarios[entry.name]})`);
    }
    const scenarioEffective = scenarioMetrics.effectiveConfig;
    if (!scenarioEffective || typeof scenarioEffective !== 'object') {
      fail(`${entry.name} did not record effectiveConfig`);
    }
    for (const key of entry.profileKeys ?? []) {
      if (scenarioEffective[key] !== effective[key]) {
        fail(`${entry.name} ran ${key}=${scenarioEffective[key]} but manifest effective is ${effective[key]}`);
      }
    }
  }

  console.log(`Evidence verified: ${dir}`);
  console.log(`Run: ${manifest.qualificationRunId} Profile: ${manifest.profile} Result: ${manifest.result}`);
  console.log(`Release integrity grade: ${manifest.releaseGrade} Industrial scale grade: ${manifest.schemaVersion >= 4 ? manifest.industrialScaleGrade : 'not-claimed-v3'}`);
  console.log(`Files: ${pinned.length} Checksums: OK Scenarios: ${requiredScenarioNames().length} Failures: ${failures.length} (unexpected: ${unexpected.length})`);
  if (manifest.dirty) console.log(`Warning: dirty worktree, releaseGrade=false`);
  process.exit(0);
}

main().catch(e => fail(e.message));
