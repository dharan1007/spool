#!/usr/bin/env node
// Render and validate the SPOOL deployment artefacts.
//
// The Helm chart is the single source of truth; this script proves that it
// renders, that it refuses to render without a release identity, and that the
// rendered objects keep the properties the daemon depends on. It needs a real
// `helm` binary: set HELM_BIN or put helm on PATH. Without one it exits 2 with
// an explicit EXTERNALLY_BLOCKED reason instead of pretending to verify.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const CHART = resolve('helm/spool');
const COMMIT = process.env.SPOOL_DEPLOY_COMMIT_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const problems = [];
const check = (value, message) => { if (!value) problems.push(message); };

function helm(args) {
  const bin = process.env.HELM_BIN || 'helm';
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let version;
try { version = helm(['version', '--short']).trim(); }
catch (error) {
  process.stderr.write('EXTERNALLY_BLOCKED: no usable helm binary (set HELM_BIN or install helm). ' + (error.code ?? error.message) + '\n');
  process.exit(2);
}
if (!/^v3\./.test(version)) {
  process.stderr.write(`EXTERNALLY_BLOCKED: helm 3.x required, found ${version}\n`);
  process.exit(2);
}

const values = {
  'release.commitSha': COMMIT,
  'ingress.enabled': 'true',
  'ingress.className': 'nginx',
  'ingress.host': 'spool.internal.corp',
  'ingress.tlsSecretName': 'spool-tls'
};

// 1. Rendering without a release identity must fail closed.
let refused = false;
try {
  helm(['template', 'spool', CHART, '--namespace', 'spool']);
} catch (error) {
  refused = /release\.commitSha/.test(String(error.stderr ?? ''));
}
check(refused, 'chart rendered without release.commitSha instead of failing closed');

// 2. Rendering with two replicas must fail closed (single-writer state), both in
// the values schema and in the template guard that protects schema-less renders.
let scaledRefused = false;
try {
  helm(['template', 'spool', CHART, '--namespace', 'spool', '--set', `release.commitSha=${COMMIT}`, '--set', 'replicaCount=2']);
} catch (error) {
  scaledRefused = /replicaCount/.test(String(error.stderr ?? ''));
}
let scaledGuardRefused = false;
try {
  helm(['template', 'spool', CHART, '--namespace', 'spool', '--skip-schema-validation', '--set', `release.commitSha=${COMMIT}`, '--set', 'replicaCount=2']);
} catch (error) {
  scaledGuardRefused = /replicaCount must be 1/.test(String(error.stderr ?? ''));
}
check(scaledRefused && scaledGuardRefused, 'chart allowed replicaCount > 1 despite single-writer state');

// 3. The supported render must lint and contain the expected invariants.
helm(['lint', CHART, '--set', `release.commitSha=${COMMIT}`, '--set', 'ingress.enabled=true', '--set', 'ingress.host=spool.internal.corp']);
const setArgs = Object.entries(values).flatMap(([key, value]) => ['--set', `${key}=${value}`]);
const rendered = helm(['template', 'spool', CHART, '--namespace', 'spool', ...setArgs]);
const count = needle => rendered.split(needle).length - 1;

check(/kind: Deployment/.test(rendered) && /replicas: 1/.test(rendered), 'deployment must pin exactly one replica');
check(/strategy:\s*\n\s*type: Recreate/.test(rendered), 'deployment must use the Recreate strategy for single-writer state');
check(/accessModes:\s*\n\s*- ReadWriteOnce/.test(rendered), 'state volume must be ReadWriteOnce');
check(/runAsNonRoot: true/.test(rendered), 'pod must be runAsNonRoot');
check(count('readOnlyRootFilesystem: true') === 2, 'both containers must use a read-only root filesystem');
check(count('drop: ["ALL"]') + count('drop:\n              - ALL') >= 2, 'both containers must drop all capabilities');
check(/seccompProfile:\s*\n\s*type: RuntimeDefault/.test(rendered), 'pod must use the RuntimeDefault seccomp profile');
check(count('name: SPOOL_DAEMON_TOKEN') === 1 && /secretKeyRef:\s*\n\s*name: spool-daemon-secrets\s*\n\s*key: SPOOL_DAEMON_TOKEN/.test(rendered), 'daemon token must come from the credentials secret');
check(/key: SPOOL_APPROVAL_SIGNING_KEY/.test(rendered), 'approval signing key must come from the credentials secret');
check((rendered.match(/proxy_set_header Host 127\.0\.0\.1:8080;/g) ?? []).length === 1, 'proxy must rewrite Host to the daemon loopback identity');
check(/targetPort: 8081/.test(rendered), 'service must target the proxy port, never the loopback daemon port');
check(count('path: /v2/health') >= 2 && count('path: /v2/ready') >= 2, 'both containers must be probed on real health and readiness routes');
check(/kind: NetworkPolicy/.test(rendered) && /policyTypes:\s*\n\s*- Ingress\s*\n\s*- Egress/.test(rendered), 'network policy must restrict ingress and egress');
check(!/:latest/.test(rendered), 'images must be pinned to explicit tags');
check(!/image: "[^"]*:?"\s*$/.test(rendered), 'image references must be complete');
check(new RegExp(`SPOOL_RELEASE_COMMIT_SHA: "${COMMIT}"`).test(rendered), 'rendered release commit must be the requested commit');
check(!/SPOOL_DAEMON_TOKEN: /.test(rendered) && !/SPOOL_APPROVAL_SIGNING_KEY: /.test(rendered), 'credentials must never be rendered literally');

const summary = {
  surface: 'deployment_render',
  helm: version,
  commitSha: COMMIT,
  objects: [...rendered.matchAll(/^kind: (\w+)$/gm)].map(match => match[1]),
  bytes: Buffer.byteLength(rendered),
  sha256: createHash('sha256').update(rendered).digest('hex'),
  failClosed: { missingCommit: refused, scaledReplicas: scaledRefused },
  problems
};

const outIndex = process.argv.indexOf('--write');
if (outIndex !== -1) {
  const target = process.argv[outIndex + 1];
  if (!target) { process.stderr.write('--write requires a destination path\n'); process.exit(1); }
  if (problems.length) { process.stderr.write('refusing to write an invalid render\n'); process.exit(1); }
  const chartVersion = (await readFile(join(CHART, 'Chart.yaml'), 'utf8')).match(/^version: (.*)$/m)?.[1] ?? 'unknown';
  const header = `# Generated by scripts/check-deployment.js from helm/spool (chart ${chartVersion}, helm ${version}).\n# Do not edit: change the chart or values and re-render.\n`;
  await mkdir(dirname(resolve(target)), { recursive: true });
  await writeFile(target, header + rendered, 'utf8');
  summary.writtenTo = target;
}

process.stdout.write('SPOOL_DEPLOYMENT_JSON=' + JSON.stringify(summary) + '\n');
if (problems.length) { process.stderr.write('deployment checks failed:\n- ' + problems.join('\n- ') + '\n'); process.exitCode = 1; }
