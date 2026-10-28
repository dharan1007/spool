// Per-artifact dependency audit.
//
// The release gate audits the CORE production dependency set
// (`npm audit --omit=dev`). Optional connector drivers are deliberately not part
// of that set (docs/DEPENDENCY_RISK.md DR-002), so they need their own audit
// rather than being silently excluded. This script audits both scopes and
// reports each one separately:
//
//   core               -> `npm audit --omit=dev` (what the tarball/daemon image installs)
//   optional-drivers   -> `npm audit` (full tree: core + devDependencies, which is
//                         the driver set a derived connector image adds)
//
// Exit code is 1 only when the core artifact has a high/critical finding. A
// finding in the optional-driver scope is recorded as OPTIONAL_SCOPE_AFFECTED
// and keeps those connectors outside the production allowlist; it is never
// reported as a pass and never hidden.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Keep in sync with docs/DEPENDENCY_RISK.md DR-001.
export const AFFECTED_MSAL_RANGE = Object.freeze({ name: '@azure/msal-node', from: '5.0.0', fixedIn: '7.1.0' });
export const OPTIONAL_DRIVER_SCOPE = Object.freeze({
  drivers: ['mssql', 'snowflake-sdk'],
  transitive: ['@azure/identity', '@azure/msal-node']
});

export const ARTIFACTS = Object.freeze({
  core: Object.freeze({ id: 'core', command: ['audit', '--omit=dev', '--audit-level=high', '--json'] }),
  optionalDrivers: Object.freeze({ id: 'optional-drivers', command: ['audit', '--audit-level=high', '--json'] })
});

function numericParts(version) {
  const [core] = String(version).split('-');
  return core.split('.').map(part => Number.parseInt(part, 10) || 0);
}

export function compareVersions(a, b) {
  const left = numericParts(a);
  const right = numericParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function isAffectedMsalVersion(version) {
  return compareVersions(version, AFFECTED_MSAL_RANGE.from) >= 0 && compareVersions(version, AFFECTED_MSAL_RANGE.fixedIn) < 0;
}

export function lockEntryKey(packages, fromKey, name) {
  let base = fromKey;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const marker = base.lastIndexOf('/node_modules/');
    base = marker === -1 ? '' : base.slice(0, marker);
  }
}

export function dependencyClosure(packages, dependencies) {
  const seen = new Set();
  const pending = Object.keys(dependencies ?? {}).map(name => ({ from: '', name }));
  while (pending.length) {
    const { from, name } = pending.pop();
    const key = lockEntryKey(packages, from, name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = packages[key] ?? {};
    for (const dependency of Object.keys({ ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) })) {
      pending.push({ from: key, name: dependency });
    }
  }
  return new Set([...seen].map(key => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)));
}

export function installedVersions(packages, names) {
  const versions = {};
  for (const name of names) {
    const entry = packages[`node_modules/${name}`];
    if (entry?.version) versions[name] = entry.version;
  }
  return versions;
}

export function classifyAudit(report) {
  const vulnerabilities = report?.vulnerabilities ?? {};
  const highs = [];
  const criticals = [];
  const advisories = new Map();
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (entry?.severity === 'high') highs.push(name);
    if (entry?.severity === 'critical') criticals.push(name);
    for (const via of entry?.via ?? []) {
      if (typeof via === 'object' && via?.source) {
        advisories.set(via.source, { source: via.source, title: via.title ?? null, url: via.url ?? null, severity: via.severity ?? null });
      }
    }
  }
  return { highs, criticals, advisories: [...advisories.values()] };
}

export function artifactVerdict(report) {
  const classification = classifyAudit(report);
  const failing = classification.highs.length + classification.criticals.length > 0;
  return { status: failing ? 'AFFECTED' : 'PASS', ...classification };
}

export function overallVerdict({ core, optionalDrivers }) {
  const coreClean = core.status === 'PASS';
  let status;
  if (!coreClean) status = 'CORE_AFFECTED';
  else if (optionalDrivers.status === 'PASS') status = 'PASS';
  else status = 'OPTIONAL_SCOPE_AFFECTED';
  return {
    status,
    coreClean,
    optionalScopeAffected: optionalDrivers.status !== 'PASS',
    productionAllowlist: coreClean ? 'allowed' : 'blocked',
    affectedConnectors: optionalDrivers.status === 'PASS' ? [] : [...OPTIONAL_DRIVER_SCOPE.drivers]
  };
}

function npmCliPath() {
  return join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function runAudit(root, args) {
  const result = spawnSync(process.execPath, [npmCliPath(), ...args], { cwd: root, encoding: 'utf8', timeout: 180_000 });
  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit did not return JSON (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return { report, exitCode: result.status };
}

export function auditArtifacts(root) {
  const results = {};
  for (const artifact of Object.values(ARTIFACTS)) {
    const { report, exitCode } = runAudit(root, artifact.command);
    results[artifact.id] = {
      command: `npm ${artifact.command.slice(0, -1).join(' ')}`,
      exitCode,
      ...artifactVerdict(report)
    };
  }
  const verdict = overallVerdict({ core: results.core, optionalDrivers: results['optional-drivers'] });
  return {
    schemaVersion: 1,
    auditRange: AFFECTED_MSAL_RANGE,
    optionalDriverScope: OPTIONAL_DRIVER_SCOPE,
    artifacts: results,
    ...verdict
  };
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const report = auditArtifacts(root);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.coreClean ? 0 : 1);
}
