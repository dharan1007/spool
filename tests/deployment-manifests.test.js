import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (...parts) => readFile(join(ROOT, ...parts), 'utf8');

// The chart is rendered by scripts/check-deployment.js where a helm binary is
// available. These assertions are the offline half of the same contract: they
// fail if the source artefacts stop expressing the properties the daemon needs.
test('image runs the production daemon entrypoint as a non-root user and never bakes credentials', async () => {
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["node", "src\/daemon\/spoold-v2-main\.js"\]$/m);
  assert.match(dockerfile, /^ENV NODE_ENV=production \\$/m);
  assert.doesNotMatch(dockerfile, /SPOOL_DAEMON_TOKEN/);
  assert.doesNotMatch(dockerfile, /SPOOL_APPROVAL_SIGNING_KEY/);
  assert.doesNotMatch(dockerfile, /--host\s+0\.0\.0\.0/, 'the daemon must never be started on a non-loopback address');
  // Dependency install must keep the native SQLite install script available.
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.doesNotMatch(dockerfile, /npm ci[^\n]*--ignore-scripts/);
});

test('chart pins single-writer state and refuses to render without a release identity', async () => {
  const values = await read('helm', 'spool', 'values.yaml');
  assert.match(values, /^replicaCount: 1$/m);
  assert.match(values, /^ {2}commitSha: ""$/m, 'release commit must be supplied per deployment, never defaulted');
  assert.match(values, /^credentialsSecretName: spool-daemon-secrets$/m);

  const schema = JSON.parse(await read('helm', 'spool', 'values.schema.json'));
  assert.equal(schema.properties.replicaCount.const, 1);
  assert.equal(schema.properties.release.properties.commitSha.pattern, '^([a-f0-9]{40})?$');

  const helpers = await read('helm', 'spool', 'templates', '_helpers.tpl');
  assert.match(helpers, /replicaCount must be 1/);
  assert.match(helpers, /release\.commitSha must be the exact 40-character lowercase release commit/);
  assert.match(helpers, /release\.version must match the shipped production policy release/);
});

test('proxy is the only network listener and rewrites Host to the daemon loopback identity', async () => {
  const configmaps = await read('helm', 'spool', 'templates', 'configmaps.yaml');
  assert.match(configmaps, /listen 8081;/);
  assert.match(configmaps, /proxy_pass http:\/\/127\.0\.0\.1:8080;/);
  assert.match(configmaps, /proxy_set_header Host 127\.0\.0\.1:8080;/);
  assert.match(configmaps, /SPOOL_DAEMON_PORT: "8080"/);

  const service = await read('helm', 'spool', 'templates', 'service.yaml');
  assert.match(service, /targetPort: \{\{ \.Values\.service\.targetPort \}\}/);
  assert.match((await read('helm', 'spool', 'values.yaml')), /^ {2}targetPort: 8081$/m);
});

test('pods are hardened and receive credentials only by secret reference', async () => {
  const deployment = await read('helm', 'spool', 'templates', 'deployment.yaml');
  assert.match(deployment, /replicas: 1/);
  assert.match(deployment, /type: Recreate/);
  assert.match(deployment, /- ReadWriteOnce/);
  assert.equal(deployment.match(/readOnlyRootFilesystem: true/g)?.length, 2);
  assert.equal(deployment.match(/drop: \["ALL"\]/g)?.length, 2);
  assert.equal(deployment.match(/allowPrivilegeEscalation: false/g)?.length, 2);
  assert.match(deployment, /runAsNonRoot: true/);
  assert.match(deployment, /seccompProfile:\n {10}type: RuntimeDefault/);
  assert.match(deployment, /automountServiceAccountToken: false/);
  assert.match(deployment, /key: SPOOL_DAEMON_TOKEN/);
  assert.match(deployment, /key: SPOOL_APPROVAL_SIGNING_KEY/);
  assert.match(deployment, /path: \{\{ \.Values\.probes\.liveness\.path \}\}/);
  assert.match(deployment, /path: \{\{ \.Values\.probes\.readiness\.path \}\}/);
  assert.doesNotMatch(deployment, /value: "?[A-Za-z0-9+/=_-]{32,}"?$/, 'no literal credential may be templated');
});

test('network policy restricts both directions and deployment documentation stays present', async () => {
  const policy = await read('helm', 'spool', 'templates', 'networkpolicy.yaml');
  assert.match(policy, /policyTypes:\n {4}- Ingress\n {4}- Egress/);
  assert.match(policy, /port: 8081/);
  assert.match(policy, /port: 53/);
  const ingress = await read('helm', 'spool', 'templates', 'ingress.yaml');
  assert.match(ingress, /ingress\.host is required when ingress is enabled/);
  assert.match(await read('deploy', 'kubernetes', 'README.md'), /single source of truth/);
});
