# P1 Shared Source-to-Target Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a transport-neutral real migration runner that executes capability-bound plans through registered connectors and the transactional `SQLiteJobStore`, preserving the existing deterministic browser kernel.

**Architecture:** Add `src/daemon/shared-runner.js` as an orchestration layer only. It opens connectors through `ConnectorRegistry`, re-validates the plan's bound connector versions/capabilities, acquires a fenced execution epoch, streams source batches, transforms them through the existing deterministic `MigrationEngine`, writes accepted rows, persists a checkpoint only after target write evidence returns, verifies the target, and atomically finalizes a receipt. Ambiguous target outcomes fail closed into `RECOVERY_REQUIRED`; no API/MCP/CLI/network surface is added in this increment.

**Tech Stack:** Node.js ESM, existing connector contract/registry, existing deterministic migration engine, built-in `node:sqlite` through `SQLiteJobStore`, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md`; `docs/superpowers/specs/2026-09-05-p1-crash-recovery-failure-matrix.md`

## Global Constraints

- Preserve the existing browser deterministic kernel and WebMCP behavior.
- Require capability-bound plans for daemon execution; legacy unbound plans remain valid for existing browser paths but are not executed by this runner.
- Never persist raw source/target rows, resolved credentials, or connector-native secret-bearing errors.
- Persist checkpoint/count progress only after target `write()` returns durable/postcondition evidence.
- On ambiguous target write failure, enter `RECOVERY_REQUIRED` and append bounded recovery evidence; never blindly replay.
- `COMPLETE` requires successful verification plus immutable receipt linkage through `SQLiteJobStore.finalizeVerifiedJob()`.
- Do not add `spoold`, HTTP, MCP, CLI, pairing, or production deployment changes in this increment.

---

### Task 1: Runner contract and real integration RED tests

**Files:**
- Create: `tests/shared-runner.test.js`

**Interfaces:**
- Consumes: `ConnectorRegistry`, `SQLiteJobStore`, `createCapabilityBoundMigrationPlan`, filesystem/sqlite connectors.
- Produces test expectations for `SharedMigrationRunner.run({ plan, sourceConfig, targetConfig, jobId? })`.

- [ ] Add a real JSONL -> SQLite integration test proving transformed rows are committed, checkpointed, verified and finalized with a receipt.
- [ ] Add a test proving target write failure with ambiguous outcome transitions the job to `RECOVERY_REQUIRED` and does not checkpoint the failed batch.
- [ ] Add a test proving connector capability/version drift is rejected before target mutation.
- [ ] Run `npm test` and confirm RED only because `src/daemon/shared-runner.js` does not exist.

### Task 2: Implement the transport-neutral shared runner

**Files:**
- Create: `src/daemon/shared-runner.js`

**Interfaces:**
- `new SharedMigrationRunner({ registry, store, ownerId, leaseMs? })`
- `run({ plan, sourceConfig, targetConfig, jobId? }) -> Promise<{ job, receipt }>`

- [ ] Require `plan.connectorBinding` and call `validateMigrationPlan(plan)`.
- [ ] Open source and target connectors using names from `plan.sourceRef.connector` / `plan.targetRef.connector`.
- [ ] Call `assertPlanConnectorCompatibility()` against the opened connector manifests before execution ownership is acquired.
- [ ] Create/load the job and acquire execution ownership; move `PLANNED` to `RUNNING` under expected stateVersion/epoch fencing.
- [ ] Stream source batches from the persisted checkpoint cursor (new jobs start at null).
- [ ] Transform each source batch with `MigrationEngine.run(rows, plan.mapping, plan.planRevision, plan.targetSchema)`.
- [ ] Write only accepted transformed rows. Require an object write acknowledgement; derive a deterministic batch identity from plan/source cursor/payload hash/target acknowledgement metadata without persisting rows.
- [ ] Commit cumulative counts + checkpoint through `store.commitCheckpoint()` only after target write returns.
- [ ] If target `write()` throws before a proven rollback result is available, append a redacted recovery event and transition to `RECOVERY_REQUIRED`; do not advance the checkpoint.
- [ ] After source exhaustion transition to `VERIFYING`, call target `verify()`, require `ok === true`, store bounded verification evidence, create a canonical receipt, and call `finalizeVerifiedJob()`.
- [ ] Close both connectors in `finally`.

### Task 3: Verification and release gate

**Files:**
- Test: `tests/shared-runner.test.js`

- [ ] Run the targeted runner tests.
- [ ] Run the full `npm run check` release gate.
- [ ] Verify no browser/WebMCP regressions, build errors, static security regressions, or dependency vulnerabilities.
- [ ] Keep PR #3 draft/unmerged and do not deploy production from this daemon-only increment.
