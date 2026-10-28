import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AFFECTED_MSAL_RANGE,
  OPTIONAL_DRIVER_SCOPE,
  ARTIFACTS,
  artifactVerdict,
  auditEmbeddedEngine,
  classifyAudit,
  compareVersions,
  dependencyClosure,
  dockerProductionClosureEqualsCore,
  installedVersions,
  isAffectedMsalVersion,
  overallVerdict
} from '../scripts/audit-artifacts.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const packages = lock.packages ?? {};
const matrix = JSON.parse(readFileSync(join(root, 'capabilities', 'matrix.json'), 'utf8'));

const AFFECTED_CAPABILITY_PREFIXES = Object.freeze(['mssql.', 'snowflake']);

test('the core production artifact excludes the affected driver closure', () => {
  const closure = dependencyClosure(packages, manifest.dependencies);
  for (const forbidden of [...OPTIONAL_DRIVER_SCOPE.drivers, ...OPTIONAL_DRIVER_SCOPE.transitive]) {
    assert.equal(closure.has(forbidden), false, `${forbidden} must not be reachable from production dependencies`);
  }
  for (const required of ['better-sqlite3', 'pg', 'mysql2', '@google-cloud/bigquery']) {
    assert.equal(closure.has(required), true, `${required} remains part of the production install`);
  }
  for (const driver of OPTIONAL_DRIVER_SCOPE.drivers) {
    assert.equal(manifest.dependencies?.[driver], undefined, `${driver} must not be a production dependency`);
    assert.equal(typeof manifest.devDependencies?.[driver], 'string', `${driver} stays a development dependency`);
  }
});

test('the optional driver artifact still carries the advisory, so it is not silently suppressed', () => {
  const driverDependencies = Object.fromEntries(
    OPTIONAL_DRIVER_SCOPE.drivers.map(driver => [driver, manifest.devDependencies[driver]])
  );
  const closure = dependencyClosure(packages, driverDependencies);
  assert.equal(closure.has('@azure/msal-node'), true, 'the optional driver closure must still resolve @azure/msal-node');
  assert.equal(closure.has('@azure/identity'), true, 'the optional driver closure must still resolve @azure/identity');

  const versions = installedVersions(packages, [AFFECTED_MSAL_RANGE.name]);
  assert.equal(typeof versions[AFFECTED_MSAL_RANGE.name], 'string', '@azure/msal-node must be installed for conformance');
  assert.equal(
    isAffectedMsalVersion(versions[AFFECTED_MSAL_RANGE.name]),
    true,
    `@azure/msal-node@${versions[AFFECTED_MSAL_RANGE.name]} is no longer inside ${AFFECTED_MSAL_RANGE.from}..${AFFECTED_MSAL_RANGE.fixedIn}; re-run the audit and update docs/DEPENDENCY_RISK.md DR-001`
  );
});

test('no capability that depends on an affected driver is promoted to production', () => {
  const promoted = matrix.capabilities
    .filter(capability => capability.status === 'PRODUCTION')
    .filter(capability => AFFECTED_CAPABILITY_PREFIXES.some(prefix => capability.id === prefix || capability.id.startsWith(prefix)))
    .map(capability => capability.id);
  assert.deepEqual(promoted, [], `capabilities backed by an affected optional driver cannot be production: ${promoted.join(', ')}`);
});

test('the affected driver capabilities are still declared and plainly not production-ready', () => {
  const affected = matrix.capabilities.filter(capability => AFFECTED_CAPABILITY_PREFIXES.some(prefix => capability.id === prefix || capability.id.startsWith(prefix)));
  assert.ok(affected.length >= 6, 'SQL Server and Snowflake capabilities must not be deleted to make the register look complete');
  for (const capability of affected) {
    assert.notEqual(capability.status, 'PRODUCTION', `${capability.id} must not be production while its driver is affected`);
    assert.ok(capability.notes === undefined || !/production[- ]ready/i.test(capability.notes), `${capability.id} notes must not claim production readiness`);
  }
});

test('version comparison and the affected range boundary', () => {
  assert.equal(compareVersions('5.6.0', '7.1.0'), -1);
  assert.equal(compareVersions('7.1.0', '7.1.0'), 0);
  assert.equal(compareVersions('7.1.1', '7.1.0'), 1);
  assert.equal(compareVersions('7.10.0', '7.9.9'), 1);
  assert.equal(isAffectedMsalVersion('5.0.0-beta.0'), true);
  assert.equal(isAffectedMsalVersion('4.9.9'), false);
  assert.equal(isAffectedMsalVersion('6.0.0'), true);
  assert.equal(isAffectedMsalVersion('7.0.9'), true);
  assert.equal(isAffectedMsalVersion('7.1.0'), false);
  assert.equal(isAffectedMsalVersion('7.1.2'), false);
});

test('audit classification separates a clean core from an affected optional scope', () => {
  const advisory = { source: 1243111, title: 'MSAL Node authorization code flow may disclose parameters', url: 'https://github.com/advisories/GHSA-xcx6-jx8p-x3h5', severity: 'high' };
  const clean = { vulnerabilities: {} };
  const affected = { vulnerabilities: { '@azure/msal-node': { severity: 'high', via: [advisory] }, '@azure/identity': { severity: 'high', via: ['@azure/msal-node'] } } };

  assert.deepEqual(classifyAudit(clean), { highs: [], criticals: [], advisories: [] });
  const classified = classifyAudit(affected);
  assert.deepEqual(classified.highs.sort(), ['@azure/identity', '@azure/msal-node']);
  assert.deepEqual(classified.criticals, []);
  assert.equal(classified.advisories.length, 1);
  assert.equal(classified.advisories[0].source, advisory.source);

  assert.equal(artifactVerdict(clean).status, 'PASS');
  assert.equal(artifactVerdict(affected).status, 'AFFECTED');

  const optionalAffected = overallVerdict({ core: artifactVerdict(clean), optionalDrivers: artifactVerdict(affected) });
  assert.equal(optionalAffected.status, 'OPTIONAL_SCOPE_AFFECTED');
  assert.equal(optionalAffected.coreClean, true);
  assert.equal(optionalAffected.optionalScopeAffected, true);
  assert.deepEqual(optionalAffected.affectedConnectors, [...OPTIONAL_DRIVER_SCOPE.drivers]);
  assert.notEqual(optionalAffected.status, 'PASS', 'an affected optional scope is never reported as an overall pass');

  const coreAffected = overallVerdict({ core: artifactVerdict(affected), optionalDrivers: artifactVerdict(clean) });
  assert.equal(coreAffected.status, 'CORE_AFFECTED');
  assert.equal(coreAffected.coreClean, false);
  assert.equal(coreAffected.productionAllowlist, 'blocked');

  const allClean = overallVerdict({ core: artifactVerdict(clean), optionalDrivers: artifactVerdict(clean) });
  assert.equal(allClean.status, 'PASS');
  assert.deepEqual(allClean.affectedConnectors, []);
});

test('a critical finding in the core artifact blocks the allowlist', () => {
  const critical = { vulnerabilities: { 'left-pad': { severity: 'critical', via: [{ source: 1, title: 'x', url: 'https://example.invalid', severity: 'critical' }] } } };
  const verdict = artifactVerdict(critical);
  assert.equal(verdict.status, 'AFFECTED');
  assert.deepEqual(verdict.criticals, ['left-pad']);
  assert.equal(overallVerdict({ core: verdict, optionalDrivers: verdict }).productionAllowlist, 'blocked');
});

test('every distributable artifact is enumerated and the Electron/runtime closure excludes optional drivers', () => {
  const ids = ARTIFACTS.map(a => a.id).sort();
  assert.deepEqual(ids, ['core', 'docker-production', 'electron-runtime', 'optional-drivers']);
  assert.equal(ARTIFACTS.find(a => a.id === 'docker-production').derivedFrom, 'core');

  const electronPkg = JSON.parse(readFileSync(join(root, 'apps/console/package.json'), 'utf8'));
  assert.equal(electronPkg.dependencies?.mssql, undefined, 'mssql must not be a runtime dependency of the Electron app');
  assert.equal(typeof electronPkg.devDependencies?.mssql, 'string', 'mssql may remain in devDependencies for tooling');
  for (const forbidden of OPTIONAL_DRIVER_SCOPE.drivers) {
    assert.equal(electronPkg.dependencies?.[forbidden], undefined, `${forbidden} must not ship in the Electron production closure`);
  }
  for (const required of ['better-sqlite3', 'pg', 'mysql2']) {
    assert.equal(typeof electronPkg.dependencies?.[required], 'string', `${required} remains required by the desktop app`);
  }

  if (existsSync(join(root, 'Dockerfile'))) {
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    assert.equal(dockerProductionClosureEqualsCore(dockerfile), true);
  }
});

test('embedded engine runtime dependencies are satisfied by the Electron closure', () => {
  const embedded = auditEmbeddedEngine(root);
  assert.equal(embedded.consistent, true, JSON.stringify(embedded));
  assert.deepEqual(embedded.missingFromElectron, []);
  assert.deepEqual(embedded.unresolvedFromClosure, []);
  assert.ok(embedded.engineDependencies.includes('better-sqlite3'));
  assert.ok(embedded.engineDependencies.includes('@google-cloud/bigquery'));

  const verdict = overallVerdict({
    core: artifactVerdict({ vulnerabilities: {} }),
    optionalDrivers: artifactVerdict({ vulnerabilities: {} }),
    electronRuntime: artifactVerdict({ vulnerabilities: {} }),
    embeddedEngine: embedded,
    dockerProduction: artifactVerdict({ vulnerabilities: {} })
  });
  assert.equal(verdict.productionAllowlist, 'allowed');
});

test('an affected Electron/runtime or embedded-engine artifact blocks production allowlist', () => {
  const clean = artifactVerdict({ vulnerabilities: {} });
  const affectedElectron = artifactVerdict({ vulnerabilities: { zod: { severity: 'high', via: [{ source: 1, title: 'x', url: 'u', severity: 'high' }] } } });
  const badEngine = { id: 'embedded-engine', status: 'AFFECTED', consistent: false, missingFromElectron: ['missing'] };

  assert.equal(overallVerdict({ core: clean, optionalDrivers: clean, electronRuntime: affectedElectron, embeddedEngine: { id: 'embedded-engine', consistent: true }, dockerProduction: clean }).productionAllowlist, 'blocked');
  assert.equal(overallVerdict({ core: clean, optionalDrivers: clean, electronRuntime: clean, embeddedEngine: badEngine, dockerProduction: clean }).productionAllowlist, 'blocked');
});
