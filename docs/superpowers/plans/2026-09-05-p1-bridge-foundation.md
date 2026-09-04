# SPOOL P1 Bridge Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn SPOOL from a browser-only CSV migration product into a real local-first developer substrate by adding a Node daemon (`spoold`), real filesystem and SQLite connectors, durable jobs/receipts, a versioned local API, CLI, and standard MCP while preserving the existing browser workflow.

**Architecture:** Keep the existing runtime-neutral planner, transform IR, schema validation, and migration engine as the semantic core. Add a separate platform layer for immutable plans, connector contracts, secret references, policy, durable job/receipt storage, and source-to-target execution; then expose that one command service through CLI, HTTP, MCP stdio, and MCP Streamable HTTP. Browser code remains backward-compatible and its production CSP remains network-closed.

**Tech Stack:** Node.js ES modules, Node >=22.13.0, built-in `node:http`, `node:crypto`, `node:fs`, `node:path`, `node:readline`, built-in `node:sqlite`, existing SPOOL core modules, MCP TypeScript SDK v2 packages `@modelcontextprotocol/server` and `@modelcontextprotocol/node`, Zod v4 for MCP schemas, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md`

## Global Constraints

- Local-first is the default: credentials and raw dataset rows MUST NOT leave the local/self-hosted SPOOL process unless the user explicitly configures a remote connector or remote execution mode.
- `spoold` binds to loopback by default; public/LAN listening requires explicit configuration.
- No arbitrary model-generated JavaScript, shell command, or unrestricted SQL execution primitive.
- Existing browser CSV, IndexedDB, Worker, WebMCP, CSP, and build behavior must remain green.
- Existing browser WebMCP tool names are not removed in P1.
- Every connector declares capabilities; planners/runners may only select advertised behavior.
- Durable checkpoints advance only after target acknowledgement.
- A job may become `COMPLETE` only after configured verification succeeds.
- Secret values never appear in plans, receipts, inspect responses, errors, logs, or traces.
- P1 must prove real filesystem -> SQLite, SQLite -> filesystem, and SQLite -> SQLite migrations; mock connectors do not count.
- MCP uses the current v2 stable SDK and current protocol direction: stdio locally and Streamable HTTP for daemon/self-hosted access; legacy HTTP+SSE is not introduced.

---

### Task 1: Runtime-neutral platform contracts and immutable plan identity

**Files:**
- Create: `src/platform/canonical-json.js`
- Create: `src/platform/contracts.js`
- Create: `src/platform/plan.js`
- Test: `tests/platform-plan.test.js`

**Interfaces:**
- Consumes: `planAutopilot()` from `src/core/autopilot.js`, `fingerprintText()`/schema helpers from `src/core/schema.js`.
- Produces: `canonicalJson(value)`, `sha256Json(value)`, `validateConnectorRef(ref)`, `validateMigrationPlan(plan)`, `createMigrationPlan(input)`, and immutable plan shape `{ planId, planRevision, sourceRef, targetRef, targetSchema, mapping, writeStrategy, verification, risk, createdAt }`.

- [ ] **Step 1: Write the failing plan identity tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256Json } from '../src/platform/canonical-json.js';
import { createMigrationPlan, validateMigrationPlan } from '../src/platform/plan.js';

test('canonical JSON and plan ID are stable across object key order', async () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(await sha256Json({ b: 2, a: 1 }), await sha256Json({ a: 1, b: 2 }));
});

test('plan identity excludes volatile createdAt but binds source, target and mapping revision', async () => {
  const base = {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', resource: 'input/customers.csv', identity: 'sha256:abc' },
    targetRef: { connector: 'sqlite', resource: 'customers' },
    targetSchema: [{ name: 'id', type: 'integer', nullable: false }],
    mapping: [{ target: 'id', expr: { op: 'field', name: 'id' } }],
    writeStrategy: { mode: 'insert', batchSize: 500 },
    verification: { checks: ['processed_count', 'target_count'] },
    risk: { level: 'low', approvals: [] }
  };
  const a = await createMigrationPlan({ ...base, createdAt: '2026-09-05T00:00:00.000Z' });
  const b = await createMigrationPlan({ ...base, createdAt: '2026-09-05T01:00:00.000Z' });
  assert.equal(a.planId, b.planId);
  assert.doesNotThrow(() => validateMigrationPlan(a));
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/platform-plan.test.js`

Expected: FAIL because `src/platform/canonical-json.js` and `src/platform/plan.js` do not exist.

- [ ] **Step 3: Implement deterministic canonicalization and plan validation**

```js
// src/platform/canonical-json.js
import { createHash } from 'node:crypto';

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) { return JSON.stringify(normalize(value)); }
export async function sha256Json(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
```

```js
// src/platform/contracts.js
import { fail } from '../core/errors.js';

export function validateConnectorRef(ref) {
  if (!ref || typeof ref !== 'object') fail('INVALID_CONNECTOR_REF', 'Connector reference must be an object');
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(ref.connector ?? '')) fail('INVALID_CONNECTOR_REF', 'Invalid connector name');
  if (typeof ref.resource !== 'string' || !ref.resource.trim()) fail('INVALID_CONNECTOR_REF', 'Connector resource is required');
  if ('secret' in ref || 'password' in ref || 'token' in ref) fail('SECRET_IN_REFERENCE', 'Connector references may contain secretRef only, never secret values');
  return structuredClone(ref);
}
```

```js
// src/platform/plan.js
import { sha256Json } from './canonical-json.js';
import { validateConnectorRef } from './contracts.js';
import { validateTargetSchema } from '../core/schema.js';
import { compileMapping } from '../core/transforms.js';
import { fail } from '../core/errors.js';

export function validateMigrationPlan(plan) {
  validateConnectorRef(plan.sourceRef);
  validateConnectorRef(plan.targetRef);
  validateTargetSchema(plan.targetSchema);
  compileMapping(plan.mapping);
  if (!Number.isInteger(plan.planRevision) || plan.planRevision < 1) fail('INVALID_PLAN_REVISION', 'planRevision must be >= 1');
  if (!Array.isArray(plan.verification?.checks) || plan.verification.checks.length === 0) fail('INVALID_VERIFICATION_POLICY', 'At least one verification check is required');
  return true;
}

export async function createMigrationPlan(input) {
  const identity = { ...structuredClone(input) };
  delete identity.createdAt;
  delete identity.planId;
  validateMigrationPlan(identity);
  return Object.freeze({ ...identity, planId: await sha256Json(identity), createdAt: input.createdAt ?? new Date().toISOString() });
}
```

- [ ] **Step 4: Run focused + existing core tests**

Run: `node --test tests/platform-plan.test.js tests/core.test.js tests/transforms.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform tests/platform-plan.test.js
git commit -m "feat: add immutable platform plan contracts"
```

---

### Task 2: Secret references, redaction, policy evaluation, and persisted connection descriptors

**Files:**
- Create: `src/platform/secrets.js`
- Create: `src/platform/redact.js`
- Create: `src/platform/policy.js`
- Create: `src/daemon/config-store.js`
- Test: `tests/platform-security.test.js`

**Interfaces:**
- Produces: `resolveSecretRef(secretRef, env)`, `redact(value)`, `evaluatePlanPolicy(plan, policy)`, `ConfigStore` with `putConnection(name, descriptor)`, `getConnection(name)`, `listConnections()`.
- Connection descriptor: `{ name, type, config, secretRefs, createdAt }`; resolved secret values are never persisted.

- [ ] **Step 1: Write failing security tests**

```js
test('redaction removes nested secret material', () => {
  const value = redact({ password: 'p', token: 't', nested: { apiKey: 'k', safe: 3 } });
  assert.deepEqual(value, { password: '[REDACTED]', token: '[REDACTED]', nested: { apiKey: '[REDACTED]', safe: 3 } });
});

test('environment secret references resolve without being embedded in descriptors', () => {
  assert.equal(resolveSecretRef({ provider: 'env', key: 'SPOOL_TEST_SECRET' }, { SPOOL_TEST_SECRET: 'value' }), 'value');
});

test('destructive overwrite requires explicit approval', () => {
  const result = evaluatePlanPolicy({ risk: { level: 'high', approvals: ['target_overwrite'] } }, { allow: [] });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.missingApprovals, ['target_overwrite']);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/platform-security.test.js`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement secret references and recursive redaction**

Implement env refs only in P1's first increment; reject unknown providers with typed errors. Persist only reference objects. Redaction keys are case-insensitive and cover `password`, `secret`, `token`, `api_key`, `apikey`, `authorization`, and `credential`.

```js
export function resolveSecretRef(ref, env = process.env) {
  if (ref?.provider !== 'env' || typeof ref.key !== 'string') fail('UNSUPPORTED_SECRET_REF', 'P1 supports env secret references');
  const value = env[ref.key];
  if (!value) fail('SECRET_NOT_FOUND', `Secret environment reference ${ref.key} is not set`);
  return value;
}
```

- [ ] **Step 4: Implement policy evaluation and atomic config persistence**

`ConfigStore` writes JSON to `<stateDir>/connections.json` using `writeFile(temp)` followed by `rename(temp, final)`. Reject descriptors containing raw secret-shaped values; allow only `secretRefs`.

- [ ] **Step 5: Run security tests**

Run: `node --test tests/platform-security.test.js tests/security.test.js`

Expected: PASS and existing browser security tests remain green.

- [ ] **Step 6: Commit**

```bash
git add src/platform src/daemon/config-store.js tests/platform-security.test.js
git commit -m "feat: add local secret and policy boundary"
```

---

### Task 3: Connector contract and capability registry

**Files:**
- Create: `src/connectors/contract.js`
- Create: `src/connectors/registry.js`
- Test: `tests/connectors-contract.test.js`

**Interfaces:**
- Produces: `validateConnector(connector)`, `ConnectorRegistry.register(name, factory)`, `ConnectorRegistry.manifest(name)`, `ConnectorRegistry.open(name, config, context)`.
- Required connector methods: `manifest`, `validateConfig`, `testConnection`, `discover`, `read`, `planWrite`, `write`, `verify`, `close`; optional `rollback`.
- Required capabilities object keys: `source`, `target`, `discover`, `streaming`, `transactions`, `bulkWrite`, `upsert`, `ddl`, `rollback`, `checksum`, `pagination`, `rateLimitAware`.

- [ ] **Step 1: Write contract rejection tests**

```js
test('connector registry rejects missing capabilities and methods', () => {
  const registry = new ConnectorRegistry();
  assert.throws(() => registry.register('bad', () => ({ manifest() { return { name: 'bad' }; } })), /connector/i);
});

test('registry refuses duplicate connector names', () => {
  const registry = new ConnectorRegistry();
  registry.register('fixture', () => validFixtureConnector());
  assert.throws(() => registry.register('fixture', () => validFixtureConnector()), /already registered/i);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/connectors-contract.test.js`

- [ ] **Step 3: Implement strict connector manifest validation**

The registry must instantiate a connector only after validating the manifest and method surface. A connector's `read()` return value must be async-iterable; a write plan may only request capabilities the manifest advertises.

- [ ] **Step 4: Run connector contract tests**

Run: `node --test tests/connectors-contract.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors tests/connectors-contract.test.js
git commit -m "feat: define capability-driven connector SDK"
```

---

### Task 4: Real filesystem connector

**Files:**
- Create: `src/connectors/filesystem.js`
- Create: `src/connectors/file-formats.js`
- Test: `tests/filesystem-connector.test.js`

**Interfaces:**
- Config: `{ root: string }`.
- Source resource paths are root-relative `.csv`, `.json`, or `.jsonl`.
- Target writes support `.csv`, `.json`, `.jsonl` and always use temp-file + fsync/close + rename.
- Produces bounded `RowBatch` objects: `{ rows, cursor: { offset }, bytesRead }`.

- [ ] **Step 1: Write real temporary-directory integration tests**

Create a temp root with a real JSONL and CSV file. Assert discovery, reads, path traversal rejection, atomic write, and deterministic verification.

```js
test('filesystem connector rejects traversal outside configured root', async () => {
  const connector = new FilesystemConnector({ root });
  await assert.rejects(() => connector.discover({}, { resource: '../secret.csv' }), /PATH_OUTSIDE_ROOT/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/filesystem-connector.test.js`

- [ ] **Step 3: Implement safe path resolution and real reads**

Use `resolve(root, resource)` and require the result to equal `root` or start with `${root}${sep}`. JSONL uses `readline.createInterface({ input: createReadStream(...) })`; CSV reuses the existing hardened parser for correctness in P1; JSON accepts only a top-level array of objects and enforces existing row/cell limits.

- [ ] **Step 4: Implement atomic targets and verify**

For JSONL, stream one JSON object per line. For JSON, write one JSON array. For CSV, use existing `toCsv()`. `verify()` reopens the committed file and returns `{ ok, targetRows, sha256, checks }`.

- [ ] **Step 5: Run filesystem + CSV safety tests**

Run: `node --test tests/filesystem-connector.test.js tests/core.test.js tests/security.test.js`

- [ ] **Step 6: Commit**

```bash
git add src/connectors tests/filesystem-connector.test.js
git commit -m "feat: add real filesystem connector"
```

---

### Task 5: Real SQLite connector on built-in `node:sqlite`

**Files:**
- Create: `src/connectors/sqlite.js`
- Create: `src/connectors/sqlite-identifiers.js`
- Test: `tests/sqlite-connector.test.js`
- Modify: `package.json`

**Interfaces:**
- Config: `{ database: string, readonly?: boolean }`.
- Resource: table name only; arbitrary SQL text is not accepted.
- Uses `DatabaseSync` from `node:sqlite`.
- Source reads paginate by primary key when a single integer primary key exists, otherwise by `LIMIT/OFFSET` with snapshot assumptions recorded.
- Target strategy: `create_insert`, `insert`, or `upsert` only; destructive recreation is policy-gated and is not a raw SQL escape hatch.

- [ ] **Step 1: Raise the runtime floor and write real SQLite tests**

Set `engines.node` to `>=22.13.0`, because `node:sqlite` is unflagged from Node 22.13. Tests create real temp `.db` files and tables.

```js
test('sqlite discovery returns columns and primary key without exposing SQL execution', async () => {
  const connector = new SQLiteConnector({ database: dbPath });
  const discovered = await connector.discover({}, { resource: 'customers' });
  assert.equal(discovered.resource, 'customers');
  assert.deepEqual(discovered.primaryKey, ['id']);
  assert.equal(typeof connector.query, 'undefined');
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/sqlite-connector.test.js`

- [ ] **Step 3: Implement identifier quoting and schema discovery**

Only accept table/column identifiers matching connector discovery results. Quote identifiers with doubled `"` characters and never interpolate user-provided values into SQL. Use prepared statements for values.

- [ ] **Step 4: Implement batched reads and transaction-aware writes**

Each write batch executes inside `BEGIN IMMEDIATE`/`COMMIT`; on error execute `ROLLBACK`. Return acknowledgement `{ committedRows, checkpointToken }` only after commit succeeds.

- [ ] **Step 5: Implement verification**

Return row count, primary-key coverage when applicable, target schema observations, and deterministic sample hash. Do not claim full-dataset checksum unless actually computed.

- [ ] **Step 6: Run SQLite tests**

Run: `node --test tests/sqlite-connector.test.js tests/connectors-contract.test.js`

Expected: PASS against real SQLite database files.

- [ ] **Step 7: Commit**

```bash
git add package.json src/connectors tests/sqlite-connector.test.js
git commit -m "feat: add real sqlite connector"
```

---

### Task 6: Durable daemon job, checkpoint, and receipt store

**Files:**
- Create: `src/daemon/job-store.js`
- Create: `src/daemon/receipt.js`
- Test: `tests/job-store.test.js`

**Interfaces:**
- `JobStore.create(plan) -> JobRecord`
- `JobStore.load(jobId)`, `JobStore.update(jobId, updater)`, `JobStore.list()`.
- Job states: `PLANNED`, `RUNNING`, `PAUSING`, `PAUSED`, `VERIFYING`, `COMPLETE`, `FAILED`, `ABORTED`.
- Checkpoint shape: `{ sourceCursor, targetBoundary, processedRows, acceptedRows, rejectedRows, planId, planRevision, updatedAt }`.
- Receipt: immutable JSON document with `receiptId`, version/runtime/connectors/redacted refs/plan identity/counts/verification/timing/policy events/terminal status.

- [ ] **Step 1: Write restart/atomicity/receipt redaction tests**

```js
test('job store survives process-style re-instantiation at the committed checkpoint', async () => {
  const first = new JobStore({ stateDir });
  const job = await first.create(plan);
  await first.update(job.jobId, current => ({ ...current, state: 'PAUSED', checkpoint: { ...checkpoint, processedRows: 500 } }));
  const second = new JobStore({ stateDir });
  assert.equal((await second.load(job.jobId)).checkpoint.processedRows, 500);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/job-store.test.js`

- [ ] **Step 3: Implement atomic file-backed state**

Store each job as `<stateDir>/jobs/<jobId>.json` and each terminal receipt as `<stateDir>/receipts/<receiptId>.json`. Use same-directory temp files + rename. Validate transitions before writes.

- [ ] **Step 4: Implement immutable receipt hashing**

Generate `receiptId` from canonical receipt content excluding `receiptId` itself. Apply `redact()` before hashing/persisting.

- [ ] **Step 5: Run job/receipt tests**

Run: `node --test tests/job-store.test.js tests/platform-security.test.js`

- [ ] **Step 6: Commit**

```bash
git add src/daemon tests/job-store.test.js
git commit -m "feat: add durable daemon jobs and receipts"
```

---

### Task 7: Shared command service and real source-to-target runner

**Files:**
- Create: `src/platform/command-service.js`
- Create: `src/platform/runner.js`
- Create: `src/platform/verification.js`
- Test: `tests/real-migration.integration.test.js`

**Interfaces:**
- `CommandService.listConnectors()`
- `CommandService.addConnection(name, descriptor)`
- `CommandService.testConnection(name)`
- `CommandService.discover(connection, resource)`
- `CommandService.planMigration(request)`
- `CommandService.runMigration(planId)`
- `CommandService.inspectJob(jobId)`
- `CommandService.pauseJob(jobId)`
- `CommandService.resumeJob(jobId)`
- `CommandService.verifyJob(jobId)`
- `CommandService.getReceipt(jobIdOrReceiptId)`.
- `MigrationRunner.run(jobId)` is the only source-to-target execution loop used by CLI/API/MCP.

- [ ] **Step 1: Write three real integration migrations**

Tests must create actual source/target files and SQLite databases:

1. JSONL -> SQLite.
2. SQLite -> JSONL.
3. SQLite -> SQLite.

Assert transformed target values, accepted/rejected counts, `COMPLETE` only after verify, and a persisted receipt.

- [ ] **Step 2: Add pause/resume and restart integration tests**

Use a deterministic test hook that pauses after N acknowledged batches; never sleep-race. Recreate `CommandService` with the same state directory and resume the persisted job.

- [ ] **Step 3: Implement planning with existing SPOOL Autopilot**

Discover source schema/sample, call existing `planAutopilot`, build a platform plan with connector write strategy and verification rules, evaluate policy, and persist the immutable plan. Do not duplicate transform inference.

- [ ] **Step 4: Implement batch execution**

Pseudo-code must become the actual runner structure:

```js
for await (const batch of source.read(ctx, readRequest)) {
  const transformed = engine.run(batch.rows, plan.mapping, plan.planRevision, plan.targetSchema);
  const ack = await target.write(ctx, writeRequest, [{ rows: transformed.output, cursor: batch.cursor }]);
  await jobStore.update(jobId, job => advanceCheckpoint(job, batch, transformed, ack));
  if (await shouldPause(jobId)) return pauseAtCommittedBoundary(jobId);
}
await transitionToVerifying(jobId);
const verification = await verifyMigration(...);
if (!verification.ok) return failVerification(jobId, verification);
return completeWithReceipt(jobId, verification);
```

- [ ] **Step 5: Enforce fail-closed resume invariants**

Before resume, reopen connectors and compare connector type/version, source identity/snapshot evidence, target identity, plan ID/revision, and checkpoint boundary. Drift yields `RESUME_INVARIANT_MISMATCH`; it does not restart silently.

- [ ] **Step 6: Run integration tests**

Run: `node --test tests/real-migration.integration.test.js`

Expected: all three real migration directions and restart recovery pass.

- [ ] **Step 7: Run current browser/core tests**

Run: `npm test`

Expected: existing tests plus new platform tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/platform tests/real-migration.integration.test.js
git commit -m "feat: execute verified real connector migrations"
```

---

### Task 8: Secure loopback `spoold` and versioned HTTP API

**Files:**
- Create: `src/daemon/auth.js`
- Create: `src/daemon/http-api.js`
- Create: `src/daemon/spoold.js`
- Test: `tests/spoold-api.test.js`

**Interfaces:**
- `startSpoold({ host = '127.0.0.1', port = 0, stateDir, allowedOrigins = [] }) -> { server, address, token, close }`.
- API prefix `/v1`.
- Bearer token required for all mutation and metadata routes except `/v1/health`.
- Browser requests with `Origin` require an exact allowed origin and bearer/pairing token.
- Raw-row responses are not exposed by default API routes.

- [ ] **Step 1: Write bind/auth/origin tests using a real ephemeral HTTP server**

Assert default address is loopback, missing token -> 401, wrong Origin -> 403, correct token -> typed envelope, and no secret values in responses.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/spoold-api.test.js`

- [ ] **Step 3: Implement token generation and constant-time comparison**

Generate 32 random bytes, encode base64url, store only in process memory for default local mode, and compare using `timingSafeEqual` after equal-length normalization.

- [ ] **Step 4: Implement explicit `/v1` routes**

Routes map directly to `CommandService` methods: connectors, connections, discover, plans, jobs, pause/resume/verify, receipts. Do not add a generic `execute`, `sql`, `shell`, or arbitrary connector-method endpoint.

- [ ] **Step 5: Add bind safety**

Reject non-loopback host unless `allowRemote: true` is explicitly set. If remote is enabled without configured authentication, fail startup.

- [ ] **Step 6: Run API + security tests**

Run: `node --test tests/spoold-api.test.js tests/platform-security.test.js tests/security.test.js`

- [ ] **Step 7: Commit**

```bash
git add src/daemon tests/spoold-api.test.js
git commit -m "feat: add secure local spoold API"
```

---

### Task 9: `spool` CLI and machine-readable automation surface

**Files:**
- Create: `src/cli/args.js`
- Create: `src/cli/format.js`
- Create: `src/cli/spool.js`
- Test: `tests/cli.test.js`
- Modify: `package.json`

**Interfaces:**
- Bin: `spool` -> `src/cli/spool.js`; `spoold` -> `src/daemon/spoold.js`.
- Commands: `init`, `connectors list`, `connect add`, `connect test`, `discover`, `plan`, `run`, `status`, `pause`, `resume`, `verify`, `receipt`, `mcp`, `serve`.
- `--json` writes one JSON envelope to stdout and diagnostics to stderr.

- [ ] **Step 1: Write CLI process tests**

Spawn `node src/cli/spool.js ...` against a temporary `SPOOL_HOME`. Test connection creation, plan/run/status/receipt, non-zero exit code on policy/error, and valid JSON under `--json`.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/cli.test.js`

- [ ] **Step 3: Implement deterministic argument parser**

Reject unknown flags and missing required values. Do not use shell interpolation. File paths are passed as direct Node arguments/config values.

- [ ] **Step 4: Implement commands as `CommandService` calls**

CLI embedded/local mode constructs `CommandService` directly; `serve` starts `spoold`; `mcp` delegates to the MCP stdio entry created in Task 10.

- [ ] **Step 5: Update package bins/scripts**

Add:

```json
{
  "bin": { "spool": "./src/cli/spool.js", "spoold": "./src/daemon/spoold.js" },
  "scripts": { "test:platform": "node --test tests/platform-*.test.js tests/*connector.test.js tests/job-store.test.js tests/real-migration.integration.test.js tests/spoold-api.test.js tests/cli.test.js" }
}
```

Keep existing scripts intact.

- [ ] **Step 6: Run CLI + full tests**

Run: `node --test tests/cli.test.js && npm test`

- [ ] **Step 7: Commit**

```bash
git add src/cli package.json tests/cli.test.js
git commit -m "feat: add spool developer CLI"
```

---

### Task 10: Standard MCP v2 over stdio and Streamable HTTP

**Files:**
- Create: `src/mcp/tools.js`
- Create: `src/mcp/server.js`
- Create: `src/mcp/stdio.js`
- Create: `src/mcp/http.js`
- Test: `tests/mcp-platform.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- MCP tools: `spool_list_connectors`, `spool_test_connection`, `spool_discover_source`, `spool_plan_migration`, `spool_run_migration`, `spool_inspect_job`, `spool_pause_job`, `spool_resume_job`, `spool_verify_job`, `spool_get_receipt`.
- All tools delegate to one `CommandService`; no MCP-only mutation path.
- stdio uses MCP v2 `serveStdio`.
- HTTP uses MCP v2 `createMcpHandler`; Node HTTP adaptation uses `@modelcontextprotocol/node`.

- [ ] **Step 1: Add current stable MCP dependencies**

Run: `npm install @modelcontextprotocol/server @modelcontextprotocol/node zod`

Do not install or implement deprecated HTTP+SSE transport.

- [ ] **Step 2: Write MCP parity tests**

Construct a temporary real source/target, call the MCP tool handlers through a test server/client path, and assert plan/job/receipt IDs and terminal counts match direct `CommandService` execution.

- [ ] **Step 3: Implement intent-level tool schemas**

Use Zod v4 schemas. Inputs carry explicit connection/resource/plan/job handles. Never expose a tool taking arbitrary SQL, filesystem path outside a configured connector root, shell command, or executable transform code.

- [ ] **Step 4: Implement stdio transport**

```js
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createSpoolMcpServer } from './server.js';

await serveStdio(() => createSpoolMcpServer({ commandService }));
```

- [ ] **Step 5: Implement Streamable HTTP transport**

Create a stateless MCP handler backed by durable SPOOL job handles. Session state is not the source of truth for jobs. Mount at `/mcp` in `spoold` after the same daemon authentication/origin boundary.

- [ ] **Step 6: Run MCP tests**

Run: `node --test tests/mcp-platform.test.js tests/spoold-api.test.js`

- [ ] **Step 7: Commit**

```bash
git add src/mcp src/daemon package.json package-lock.json tests/mcp-platform.test.js
git commit -m "feat: expose spool through standard mcp v2"
```

---

### Task 11: Interface parity, security regression, docs, and release gate

**Files:**
- Create: `tests/interface-parity.test.js`
- Create: `docs/BRIDGE.md`
- Create: `docs/CONNECTORS.md`
- Create: `docs/MCP_SERVER.md`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/THREAT_MODEL.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/static-check.js`

**Interfaces:**
- Same migration through direct service, CLI, HTTP API, and MCP stdio must yield equivalent plan semantics, terminal state, accepted/rejected counts, verification result, and receipt shape.

- [ ] **Step 1: Add interface parity test**

Run one filesystem -> SQLite fixture through all four interfaces. Normalize only transport-specific timestamps/IDs where the spec allows; do not hide semantic differences.

- [ ] **Step 2: Add security regression assertions**

Static check must reject: non-loopback daemon default, generic SQL/shell/exec endpoints, literal secret fixture leakage outside tests, browser `connect-src` weakening, removed boot watchdog, and deprecated MCP SSE transport imports.

- [ ] **Step 3: Document exact real workflows**

`docs/BRIDGE.md` includes:

```bash
spool connect add source --type sqlite --database ./legacy.db
spool connect add target --type filesystem --root ./out
spool plan --source source:customers --target target:customers.jsonl --outcome database_ready
spool run <printed-plan-id>
spool status <printed-job-id>
spool receipt <printed-job-id>
```

Also document file -> SQLite and MCP client configuration for stdio.

- [ ] **Step 4: Update CI**

Use Node 22 current LTS-compatible runner, `npm ci --ignore-scripts`, `npm run check`, plus the real connector/platform integration tests if not already covered by `npm test`.

- [ ] **Step 5: Run the complete release gate**

Run:

```bash
npm ci --ignore-scripts
npm test
npm run build
npm run benchmark
node scripts/static-check.js
npm run check
```

Expected: zero failing tests, existing browser release assertions green, new P1 integration/parity/security tests green, build still emits same-origin browser ES modules, and no production browser CSP weakening.

- [ ] **Step 6: Run real CLI acceptance flows in temporary directories**

Execute SQLite -> filesystem and filesystem -> SQLite using the actual `spool` CLI entry; inspect target records and generated receipts. No fixture-only in-memory connector counts.

- [ ] **Step 7: Commit documentation/release gate**

```bash
git add tests/interface-parity.test.js docs README.md .github/workflows/ci.yml scripts/static-check.js
git commit -m "docs: ship verified P1 bridge foundation"
```

---

## P1 Completion Gate

P1 is not complete until all of these are true:

1. Real filesystem -> SQLite, SQLite -> filesystem, and SQLite -> SQLite flows pass.
2. Pause/resume and process-restart recovery resume only from acknowledged durable boundaries.
3. Verification is required before `COMPLETE` and an immutable redacted receipt exists.
4. Direct service, CLI, API, and MCP stdio produce equivalent semantic outcomes.
5. `spoold` is loopback-only and authenticated by default.
6. Secret values are absent from persisted descriptors, jobs, plans, receipts, logs, inspect responses, and errors.
7. There is no raw SQL, shell, arbitrary executable code, or generic connector-call primitive.
8. Existing browser CSV/WebMCP/Worker/IndexedDB/CSP tests remain green.
9. The live website is deployed only after the complete release gate passes; P1 server/CLI artifacts are not claimed deployed merely because the static website is green.
