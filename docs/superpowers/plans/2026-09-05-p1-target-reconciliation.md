# P1 Target Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable pre-write pending-batch record and connector-driven crash reconciliation so takeover resumes only from a connector-proven target boundary.

**Architecture:** Extend the existing connector contract with an optional-but-required-when-advertised reconciliation method. Extend `SQLiteJobStore` with fenced pending-batch persistence and clearing. Update `SharedMigrationRunner` to persist batch intent before target mutation and reconcile `RECOVERING` jobs before any source read or write. Existing concrete connectors remain conservative and unchanged in advertised crash-reconciliation capability.

**Tech Stack:** Node.js ESM, built-in `node:sqlite`, Node test runner, existing SPOOL deterministic migration engine and connector registry.

**Spec:** `docs/superpowers/specs/2026-09-05-p1-target-reconciliation-design.md`

## Global Constraints

- Preserve the deterministic browser kernel and current browser/WebMCP path unchanged.
- Do not upgrade SQLite/filesystem `reconcileAfterCrash` capability in this increment.
- Never persist raw rows or resolved secret values.
- Checkpoint metadata must never precede target durability.
- Unknown reconciliation results must become `RECOVERY_REQUIRED`.
- Keep PR #3 draft/unmerged and do not deploy this daemon-only increment to production.

---

### Task 1: Connector reconciliation contract

**Files:**
- Modify: `src/connectors/contract.js`
- Test: `tests/connector-capability-profile.test.js`

**Interfaces:**
- Consumes: `validateConnector(connector)` and `capabilityProfile.target.reconcileAfterCrash`.
- Produces: conditional requirement for `connector.reconcileTargetCommit(ctx, request)` whenever crash reconciliation is advertised.

- [ ] **Step 1: Write failing tests** proving a connector advertising `reconcileAfterCrash: true` is rejected without `reconcileTargetCommit()`, and accepted with the method.
- [ ] **Step 2: Run `node --test tests/connector-capability-profile.test.js`** and confirm only the new contract case fails.
- [ ] **Step 3: Implement minimal conditional method validation** after manifest normalization.
- [ ] **Step 4: Re-run the targeted test** and require zero failures.

### Task 2: Durable pending-batch JobStore boundary

**Files:**
- Modify: `src/daemon/sqlite-job-store.js`
- Modify: `src/platform/runtime-contracts.js`
- Test: `tests/sqlite-job-store.test.js`

**Interfaces:**
- Produces: `beginPendingBatch(jobId, pendingBatch, { expectedStateVersion, expectedExecutionEpoch })`.
- Produces: `clearPendingBatch(jobId, { expectedStateVersion, expectedExecutionEpoch })`.
- Updates: `commitCheckpoint()` atomically writes checkpoint/counts and clears `pendingBatch`.

- [ ] **Step 1: Write failing tests** proving pending intent is persisted with CAS/epoch fencing, raw-row fields are rejected, checkpoint commit clears it atomically, and stale writers cannot clear another owner's intent.
- [ ] **Step 2: Run `node --test tests/sqlite-job-store.test.js`** and confirm RED.
- [ ] **Step 3: Add `pendingBatch: null` to new jobs and validate bounded pending-batch metadata** (plan identity, batch identity, source cursor, payload hash, target identity, cumulative counts).
- [ ] **Step 4: Implement fenced `beginPendingBatch()` and `clearPendingBatch()` using existing transactional mutation primitives.**
- [ ] **Step 5: Modify `commitCheckpoint()` so the same transaction clears `pendingBatch`.**
- [ ] **Step 6: Re-run the targeted JobStore test** and require zero failures.

### Task 3: Shared runner pre-write intent and recovery

**Files:**
- Modify: `src/daemon/shared-runner.js`
- Test: `tests/shared-runner.test.js`

**Interfaces:**
- Consumes: `beginPendingBatch`, `clearPendingBatch`, `commitCheckpoint`, connector `reconcileTargetCommit`.
- Produces: deterministic pre-write `batchIdentity` and recovery handling for `COMMITTED`, `NOT_COMMITTED`, and `UNKNOWN`.

- [ ] **Step 1: Write failing integration tests** using a test-only reconcile-capable target connector. Case A simulates target commit followed by metadata checkpoint failure, then lease takeover; reconciliation returns `COMMITTED` and the second runner must checkpoint without issuing a second target write. Case B returns `UNKNOWN` with a secret-bearing native error/details and must end in `RECOVERY_REQUIRED` without leaking the secret. Case C returns `NOT_COMMITTED` and must clear pending intent before replay.
- [ ] **Step 2: Run `node --test tests/shared-runner.test.js`** and confirm RED while existing runner cases remain green.
- [ ] **Step 3: Move batch-identity derivation before target write** and exclude post-commit acknowledgement data from the identity.
- [ ] **Step 4: Persist `pendingBatch` after lease renewal and immediately before `target.write()`.**
- [ ] **Step 5: On normal success, build checkpoint from pending intent + bounded commit evidence; `commitCheckpoint()` clears the intent.**
- [ ] **Step 6: On `RECOVERING`, reconcile before source read.** `COMMITTED` commits the recovered checkpoint, `NOT_COMMITTED` clears pending and transitions to `RUNNING`, `UNKNOWN`/malformed/unsupported fails closed.
- [ ] **Step 7: Re-run targeted runner tests** and require zero failures.

### Task 4: Full release gate

**Files:**
- No production-surface changes beyond Tasks 1-3.

- [ ] **Step 1: Run `npm ci --ignore-scripts`.** Require zero audit vulnerabilities.
- [ ] **Step 2: Run `npm run check`.** Require all tests, build, benchmark, and static release/security checks to pass.
- [ ] **Step 3: Inspect PR #3 head/state and production Vercel state.** Keep PR draft/unmerged; do not deploy.
- [ ] **Step 4: Report exact commit SHA, test totals, build/security result, production health, and next priority.**

## Self-review

The plan covers every acceptance criterion in the focused reconciliation design. There are no placeholders or intentionally deferred behaviors inside this increment. Concrete SQLite/filesystem reconciliation remains outside scope by design because their currently advertised capability is correctly `false`; implementing that proof is the next connector-specific increment after the protocol itself is green.
