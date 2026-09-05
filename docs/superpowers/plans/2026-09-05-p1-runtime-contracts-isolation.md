# P1 Runtime Contracts and Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Increment A from the approved SPOOL hybrid/local-first architecture: runtime-neutral durable job/checkpoint/verification/receipt contracts, explicit recovery and ownership semantics, and structural separation of runtime secrets/raw rows from durable/public DTOs without changing the existing browser execution path.

**Architecture:** Keep the existing deterministic kernel authoritative. Add focused platform modules for durable execution-state invariants and runtime-only values, then adapt the current file-backed JobStore to validate those contracts without turning it into the final transactional store. Public projections are explicit allowlists; runtime-only secret values refuse JSON serialization. Increment B will later replace file persistence with transactional SQLite.

**Tech Stack:** Node.js >=22.13.0, ECMAScript modules, node:test, existing SPOOL error/canonical JSON helpers.

**Spec:** `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md`

## Global Constraints

- Preserve the existing deterministic kernel, browser CSV flow, WebMCP behavior, and production CSP boundary.
- No `spoold`, HTTP listener, MCP transport, CLI transport, or browser pairing in this increment.
- No raw source/target rows or resolved secret values may be accepted into durable job/checkpoint/receipt/public-status DTOs.
- Job state includes `RECOVERING` and `RECOVERY_REQUIRED` before any recovery-capable runner is built.
- Durable mutations carry monotonic `stateVersion`; execution-owned mutations carry an execution epoch.
- `COMPLETE` remains impossible until verification passes and an immutable receipt identity is linked.
- Existing release gate remains `npm test && npm run build && npm run benchmark && node scripts/static-check.js`.

---

### Task 1: Durable runtime execution contracts

**Files:**
- Create: `src/platform/runtime-contracts.js`
- Create: `tests/runtime-contracts.test.js`

**Interfaces:**
- Produces: `JOB_STATES`, `TERMINAL_JOB_STATES`, `validateJobRecord(job)`, `assertJobTransition(previous, next)`, `validateCheckpointContract(checkpoint, job)`, `validateExecutionOwnership(job, expectedEpoch)`, `safeDurableClone(value, context)`.
- Consumes: `fail()` from `src/core/errors.js`.

- [ ] **Step 1: Write failing contract tests**

Cover exact cases:

```js
assert.equal(JOB_STATES.has('RECOVERING'), true);
assert.equal(JOB_STATES.has('RECOVERY_REQUIRED'), true);
assert.throws(() => assertJobTransition(running, { ...running, state: 'COMPLETE' }), /VERIFICATION|RECEIPT/);
assert.throws(() => validateExecutionOwnership({ executionEpoch: 4 }, 3), /STALE_EXECUTION_EPOCH/);
assert.throws(() => validateCheckpointContract({ ...checkpoint, planRevision: 2 }, job), /CHECKPOINT_PLAN_MISMATCH/);
assert.throws(() => safeDurableClone({ rows: [{ id: 1 }] }, 'job'), /RAW_ROW|DURABLE/);
```

Also prove `stateVersion` and `executionEpoch` are non-negative safe integers and immutable job/plan identity cannot change across transitions.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test tests/runtime-contracts.test.js`
Expected: FAIL because `src/platform/runtime-contracts.js` does not exist.

- [ ] **Step 3: Implement minimal contract module**

Use one transition table with these legal state families:

```text
PLANNED -> RUNNING | FAILED | ABORTED
RUNNING -> PAUSING | PAUSED | VERIFYING | RECOVERING | RECOVERY_REQUIRED | FAILED | ABORTED
PAUSING -> PAUSED | RECOVERING | RECOVERY_REQUIRED | FAILED | ABORTED
PAUSED -> RUNNING | RECOVERING | RECOVERY_REQUIRED | FAILED | ABORTED
VERIFYING -> COMPLETE | RECOVERING | RECOVERY_REQUIRED | FAILED | ABORTED
RECOVERING -> RUNNING | PAUSED | VERIFYING | RECOVERY_REQUIRED | FAILED | ABORTED
RECOVERY_REQUIRED -> RECOVERING | FAILED | ABORTED
COMPLETE | FAILED | ABORTED -> no transitions
```

`COMPLETE` validation additionally requires `verification.status === 'PASS' || verification.ok === true` for backward compatibility and a non-empty `receiptId`.

`safeDurableClone()` recursively rejects keys `rows`, `rowBatch`, `rawRows`, `resolvedSecret`, `secretValue`, `authorization`, and instances marked runtime-only by Task 2.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `node --test tests/runtime-contracts.test.js`
Expected: PASS.

### Task 2: Runtime-only secret values and public DTO projections

**Files:**
- Modify: `src/platform/secrets.js`
- Create: `src/platform/public-dto.js`
- Create: `tests/platform-isolation.test.js`

**Interfaces:**
- Produces: `RuntimeSecret`, `resolveSecretRef(ref, env)` returning `RuntimeSecret`, `unwrapRuntimeSecret(value)`, `projectPublicJob(job)`, `projectPublicReceipt(receipt)`, `normalizePublicError(error)`.
- Consumes: `safeDurableClone()` from Task 1 and existing `redact()` behavior where appropriate.

- [ ] **Step 1: Write failing isolation tests**

Required assertions:

```js
const secret = resolveSecretRef({ provider: 'env', key: 'DB_PASSWORD' }, { DB_PASSWORD: 's3cr3t' });
assert.throws(() => JSON.stringify(secret), /SECRET_SERIALIZATION_BLOCKED/);
assert.equal(unwrapRuntimeSecret(secret), 's3cr3t');
assert.doesNotMatch(JSON.stringify(projectPublicJob(internalJob)), /s3cr3t|raw-row-value/);
assert.equal('secretRefs' in projectPublicJob(internalJob), false);
assert.deepEqual(normalizePublicError(Object.assign(new Error('postgres://user:s3cr3t@host'), { code: 'CONNECT_FAILED' })).code, 'CONNECT_FAILED');
assert.doesNotMatch(JSON.stringify(normalizePublicError(error)), /s3cr3t/);
```

Public job projection is an allowlist containing only schema/version IDs, state, counts, safe checkpoint metadata, safe verification summary, receiptId, timestamps, and normalized lastError.

- [ ] **Step 2: Run focused test and confirm RED**

Run: `node --test tests/platform-isolation.test.js`
Expected: FAIL because the new runtime-only/public DTO interfaces are absent.

- [ ] **Step 3: Implement runtime-only and projection modules**

`RuntimeSecret` stores the resolved value in a private field, exposes no enumerable secret data, and implements `toJSON()` by throwing `SECRET_SERIALIZATION_BLOCKED`. `unwrapRuntimeSecret()` is the only supported extraction path and rejects non-`RuntimeSecret` values.

`projectPublicJob()` and `projectPublicReceipt()` construct new allowlisted objects rather than cloning internal records. `normalizePublicError()` returns `{ code, class, retryable, message }` with a generic message for unknown/native connector errors and never serializes arbitrary error properties/stacks.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `node --test tests/platform-isolation.test.js`
Expected: PASS.

### Task 3: Adapt file-backed JobStore to Increment A invariants

**Files:**
- Modify: `src/daemon/job-store.js`
- Modify: `tests/job-store.test.js`

**Interfaces:**
- Consumes: Task 1 runtime contracts.
- Produces: current `JobStore` API with additive `stateVersion` and `executionEpoch` fields; `update(jobId, updater, { expectedStateVersion, expectedExecutionEpoch } = {})`.

- [ ] **Step 1: Add failing JobStore tests**

Cover:

```js
assert.equal(job.stateVersion, 0);
assert.equal(job.executionEpoch, 0);
await store.update(job.jobId, current => ({ ...current, state: 'RUNNING', executionEpoch: 1 }), { expectedStateVersion: 0 });
await assert.rejects(() => store.update(job.jobId, current => current, { expectedStateVersion: 0 }), /STALE_STATE_VERSION/);
await assert.rejects(() => store.update(job.jobId, current => ({ ...current, state: 'PAUSED' }), { expectedExecutionEpoch: 0 }), /STALE_EXECUTION_EPOCH/);
await assert.rejects(() => store.update(job.jobId, current => ({ ...current, state: 'COMPLETE', verification: { status: 'PASS' } })), /RECEIPT/);
```

Also assert checkpoint counters and job counters move together: an update that changes one without the other fails closed.

- [ ] **Step 2: Run focused JobStore tests and confirm RED**

Run: `node --test tests/job-store.test.js`
Expected: FAIL on missing version/epoch behavior.

- [ ] **Step 3: Implement additive compatibility changes**

Create jobs with `stateVersion: 0` and `executionEpoch: 0`. Before updater execution, compare provided expected values against persisted state. After validation, increment `stateVersion` exactly once for every successful persisted mutation. Delegate transition/checkpoint/terminal validation to `runtime-contracts.js`.

Do not claim this file-backed compare-before-write implementation is multi-process transactional CAS; Increment B replaces it with SQLite. Its purpose here is contract compatibility and deterministic single-writer behavior.

- [ ] **Step 4: Run JobStore tests and confirm GREEN**

Run: `node --test tests/job-store.test.js`
Expected: PASS.

### Task 4: Regression/security/release verification

**Files:**
- No production files unless a regression discovered by the gate requires a narrowly scoped compatibility fix.

- [ ] **Step 1: Run Increment A focused tests**

Run: `node --test tests/runtime-contracts.test.js tests/platform-isolation.test.js tests/job-store.test.js tests/platform-security.test.js`
Expected: PASS.

- [ ] **Step 2: Run full project release gate**

Run: `npm test && npm run build && npm run benchmark && node scripts/static-check.js`
Expected: all commands exit 0.

- [ ] **Step 3: Inspect browser compatibility evidence**

Confirm existing WebMCP, migration, worker, CSP, transform, and browser tests remain green. No production CSP file should change in this increment.

- [ ] **Step 4: Security review**

Search changed runtime code and serialized fixtures for resolved test secret literals and raw-row fixtures. Confirm no new network listener, `child_process`, `eval`, `Function`, unrestricted SQL execution, or public bind behavior was introduced.

- [ ] **Step 5: Commit only the green Increment A implementation**

Commit message: `feat: enforce P1 runtime contracts and isolation`

Do not merge or deploy from this increment. Production remains on the existing browser release until a separately reviewed browser-facing change is intentionally released.
