# P1 Safe Lifecycle Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe daemon job pause/resume/verify semantics without allowing a transport to report `PAUSED` while an execution can still mutate the target.

**Architecture:** Introduce one in-process execution controller shared by `SpoolCommandService` and `SharedMigrationRunner`. Managed daemon jobs persist a secret-free execution binding (plan plus named-connection fingerprints) so resume after a daemon restart can reconstruct the same execution intent from durable state. Pause is cooperative: a request sets only an in-memory intent; the runner acknowledges it only after a durable checkpoint with `pendingBatch == null`, transitions `RUNNING -> PAUSING -> PAUSED`, and clears execution ownership. Resume always re-enters the existing runner, which revalidates connector versions/capabilities and reconciliation rules before mutation. Explicit verification reuses the runner's connector verification path and never introduces a parallel verifier.

**Tech Stack:** Node.js ESM, `node:test`, `node:sqlite`, existing SPOOL deterministic kernel, connector registry, `SQLiteJobStore`, local `spoold` HTTP transport.

**Spec:** `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md`

## Global Constraints

- Preserve the existing browser CSV/WebMCP kernel and its command semantics.
- Do not persist raw rows, resolved secret values, or connector-native exception text.
- Checkpoints advance only after target commit acknowledgement.
- Never pause while `pendingBatch` is unresolved.
- Resume must use the same capability-bound plan and must fail closed on connection/connector drift or unresolved recovery.
- `COMPLETE` still requires successful verification plus immutable receipt linkage.
- Existing blocking `runMigration()` behavior remains the default; detached daemon execution is opt-in so existing direct callers remain backward compatible.
- No production deployment from this increment unless the complete release gate is green and deployment is independently justified.

---

### Task 1: Durable managed-job execution binding

**Files:**
- Modify: `src/daemon/sqlite-job-store.js`
- Modify: `src/daemon/command-service.js`
- Test: `tests/job-lifecycle-parity.test.js`

**Interfaces:**
- Produces: `SQLiteJobStore.create(plan, { executionContext? })` where `executionContext` contains `{ schemaVersion: 1, plan, sourceConnection: { name, fingerprint }, targetConnection: { name, fingerprint } }`.
- Produces: internal command-service helpers that hash safe connection descriptors and revalidate them before resume/verify.

- [ ] **Step 1: Write failing tests for execution-context persistence and drift rejection**

```js
const job = await jobStore.create(plan, { executionContext });
assert.equal(job.executionContext.plan.planId, plan.planId);
assert.equal(job.executionContext.sourceConnection.name, 'source');
assert.doesNotMatch(JSON.stringify(job), /resolvedSecret|secretValue/);

await service.putConnection({ name: 'target', type: 'sqlite', config: { database: otherDb }, secretRefs: {} });
await assert.rejects(() => service.resumeJob({ jobId: job.jobId }), /drift|connection/i);
```

- [ ] **Step 2: Run the lifecycle test file and verify RED**

Run: `node --test tests/job-lifecycle-parity.test.js`
Expected: FAIL because managed execution context/resume APIs do not exist.

- [ ] **Step 3: Extend `SQLiteJobStore.create()` without breaking legacy callers**

Store `executionContext: null` when omitted. When supplied, pass it through `safeDurableClone()`, require schema version 1, require its embedded plan identity to equal the job plan identity, and rely on public DTO allowlisting so the context never appears in inspect responses.

- [ ] **Step 4: Bind connection fingerprints in `SpoolCommandService`**

Compute each fingerprint with the existing canonical SHA-256 helper over only durable descriptor material:

```js
{
  domain: 'spool-connection-binding-v1',
  name: descriptor.name,
  type: descriptor.type,
  config: descriptor.config ?? {},
  secretRefs: descriptor.secretRefs ?? {}
}
```

No resolved secret is part of the hash. Resume/verify load the named descriptor and reject a fingerprint mismatch before opening connectors.

- [ ] **Step 5: Run lifecycle + existing command-service tests**

Run: `node --test tests/job-lifecycle-parity.test.js tests/command-service.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `feat: bind managed jobs to durable execution context`

---

### Task 2: Cooperative execution controller and safe pause boundary

**Files:**
- Create: `src/daemon/execution-controller.js`
- Modify: `src/daemon/shared-runner.js`
- Modify: `src/daemon/runtime.js`
- Test: `tests/job-lifecycle-parity.test.js`

**Interfaces:**
- Produces: `ExecutionController.start(jobId, taskFactory)`, `requestPause(jobId)`, `bindExecution(jobId, epoch)`, and `shouldPause(jobId, epoch)`.
- `SharedMigrationRunner` consumes the controller but remains usable without one for legacy/direct tests.

- [ ] **Step 1: Add failing concurrency tests**

Tests must prove all of the following:

```text
pause before first target write -> zero target writes, PAUSED, no pending batch
pause during target write -> write commits, checkpoint commits, then PAUSED
PAUSED -> no execution owner and no lease
pause during VERIFYING -> rejected rather than pretending the job paused
stale epoch/controller binding -> cannot pause a replacement execution
```

Use a controllable target connector promise/barrier so the test can issue the pause while `write()` is in flight.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/job-lifecycle-parity.test.js`
Expected: FAIL because `ExecutionController` and runner pause checkpoints do not exist.

- [ ] **Step 3: Implement `ExecutionController`**

Keep only runtime state in memory. Never serialize controller records. A record contains `jobId`, optional bound `executionEpoch`, `pauseRequested`, and the active task promise. Duplicate active execution for one job fails closed.

- [ ] **Step 4: Add `SharedMigrationRunner.maybePause()`**

Call it only at safe boundaries: immediately after entering `RUNNING`, after each successful `commitCheckpoint()`, and before entering `VERIFYING`.

When requested:

```text
assert pendingBatch == null
RUNNING -> PAUSING (fenced stateVersion + epoch)
PAUSING -> PAUSED while clearing executionOwner/executionLeaseExpiresAt
return { job, receipt: null, paused: true }
```

Do not check or acknowledge pause between `beginPendingBatch()` and `commitCheckpoint()`.

- [ ] **Step 5: Wire one controller into `createSpooldRuntime()`**

The runtime, runner, and command service receive the same controller instance. Browser-only code remains untouched.

- [ ] **Step 6: Run lifecycle, runner, recovery, and SQLite reconciliation tests**

Run: `node --test tests/job-lifecycle-parity.test.js tests/shared-runner.test.js tests/shared-runner-lease-recovery.test.js tests/target-reconciliation.test.js tests/sqlite-native-reconciliation.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

Commit message: `feat: add checkpoint-safe execution pause controller`

---

### Task 3: Transport-neutral pause, resume, verify and detached run

**Files:**
- Modify: `src/daemon/command-service.js`
- Modify: `src/daemon/shared-runner.js`
- Test: `tests/job-lifecycle-parity.test.js`
- Test: `tests/command-service.test.js`

**Interfaces:**
- Produces: `pauseJob({ jobId })`, `resumeJob({ jobId, detach? })`, `verifyJob({ jobId })`.
- Extends: `runMigration({ plan, sourceConnection, targetConnection, jobId?, detach? })`; `detach` defaults to `false`.

- [ ] **Step 1: Add failing service tests for lifecycle commands**

Prove:

```text
runMigration(detach:true) returns a durable job handle before completion
pauseJob waits until the runner reaches a safe PAUSED boundary
resumeJob uses durable execution context; no plan/config re-entry is required
verifyJob on PAUSED reuses connector verify and persists bounded verification evidence
verify failure enters RECOVERY_REQUIRED
COMPLETE verify returns existing immutable verification/receipt evidence
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/job-lifecycle-parity.test.js tests/command-service.test.js`
Expected: FAIL on the missing lifecycle service methods.

- [ ] **Step 3: Implement managed run scheduling**

For a new command-service job, create it first with durable execution context, then run through `ExecutionController.start(jobId, () => runner.run(...))`. `detach:false` awaits the task exactly as before; `detach:true` returns the current public job immediately. Attach a handled rejection path so detached failures never become unhandled process rejections.

- [ ] **Step 4: Implement `pauseJob()` and `resumeJob()`**

`pauseJob()` accepts only locally active `PLANNED/RUNNING/PAUSING` executions or already-PAUSED jobs. It never mutates the job directly; it requests controller pause and returns the final public job after the runner acknowledges the safe boundary.

`resumeJob()` accepts `PAUSED` and recoverable `RECOVERY_REQUIRED` jobs, validates durable connection fingerprints, and calls the same runner. Resuming `PAUSED -> RUNNING` clears stale partial verification evidence.

- [ ] **Step 5: Extract/reuse runner verification for `verifyJob()`**

For `PAUSED`, acquire a fenced execution lease, revalidate the plan and live target connector, run the existing bounded connector verification logic against durable counts, persist the bounded evidence, release ownership, and remain `PAUSED`. A verification mismatch/error transitions to `RECOVERY_REQUIRED`. For `COMPLETE`, return the already-linked receipt verification instead of rerunning target I/O.

- [ ] **Step 6: Run service and lifecycle tests**

Run: `node --test tests/job-lifecycle-parity.test.js tests/command-service.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

Commit message: `feat: expose safe job lifecycle commands`

---

### Task 4: spoold/client/CLI lifecycle parity

**Files:**
- Modify: `src/daemon/spoold.js`
- Modify: `src/client/spoold-client.js`
- Modify: `src/cli/main.js`
- Test: `tests/spoold-host.test.js`
- Test: `tests/spoold-client-cli.test.js`
- Test: `tests/spoold-runtime.test.js`

**Interfaces:**
- Adds command names: `pause_job`, `resume_job`, `verify_job`.
- No transport may import connectors, `SharedMigrationRunner`, or `SQLiteJobStore` directly.

- [ ] **Step 1: Add failing parity tests**

Verify host/client/CLI accept the three lifecycle commands, authentication/origin/body limits still apply, and each command dispatches only through `SpoolCommandService`.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/spoold-host.test.js tests/spoold-client-cli.test.js tests/spoold-runtime.test.js`
Expected: FAIL because the transport allowlists do not include the lifecycle commands.

- [ ] **Step 3: Extend only command allowlists/mappings**

Add the three names to `spoold`, client, and CLI allowlists. Do not add lifecycle business logic to transport files.

- [ ] **Step 4: Run transport tests**

Run: `node --test tests/spoold-host.test.js tests/spoold-client-cli.test.js tests/spoold-runtime.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: expose lifecycle parity through spoold and cli`

---

### Task 5: Full verification gate

**Files:**
- No production-file changes unless a failing test identifies a root cause.

- [ ] **Step 1: Run the repository release gate**

Run: `npm ci --ignore-scripts && npm run check`
Expected: all tests pass, build succeeds, benchmark completes, static release/security check passes, dependency audit reports zero vulnerabilities.

- [ ] **Step 2: Confirm PR state and exact-head workflow result**

Confirm PR #3 stays draft/unmerged and the release-gate workflow for the exact final head is `completed/success`.

- [ ] **Step 3: Re-check production without deploying**

Confirm the current Vercel production deployment remains `READY` and review the previous 24 hours of runtime errors. Do not deploy this daemon-only increment.

- [ ] **Step 4: Report evidence and next priority**

Report exact commit SHA, test count, build/security results, PR/deployment status, and recommend standard MCP stdio as the next increment only after lifecycle parity is green.
