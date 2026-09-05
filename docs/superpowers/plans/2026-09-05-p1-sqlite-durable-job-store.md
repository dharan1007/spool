# P1 Transactional SQLite JobStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a transactional daemon execution store that provides cross-process CAS, execution-epoch fencing, atomic checkpoint/counter commits, recoverable terminal receipt linkage, and startup recovery without changing the existing browser kernel or removing the legacy file-backed JobStore.

**Architecture:** Introduce `SQLiteJobStore` as an additive daemon persistence implementation using Node's built-in `node:sqlite`. SQLite is the mutation authority for daemon jobs: state columns used for compare-and-swap live beside a canonical JSON record, receipts are keyed immutably, and recovery evidence is append-only. Existing `JobStore` remains available for backward compatibility until the shared runner is explicitly migrated.

**Tech Stack:** Node.js ESM, built-in `node:sqlite`, existing runtime contracts, existing canonical JSON/receipt contracts, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md`, refined by `docs/superpowers/specs/2026-09-05-p1-crash-recovery-failure-matrix.md` and `docs/superpowers/specs/2026-09-05-p1-jobstore-concurrency-durability-audit.md`.

## Global Constraints

- Preserve the existing deterministic browser kernel and WebMCP behavior.
- Do not replace or remove `src/daemon/job-store.js` in this increment.
- Persist no raw source/target rows and no resolved secret values.
- Every job mutation increments `stateVersion` exactly once.
- Execution-owned mutations are fenced by `executionEpoch`.
- A checkpoint represents only a target boundary already proven durable by the caller; checkpoint and cumulative counts commit atomically.
- `RECOVERY_REQUIRED` permits no further execution-owned checkpoint writes.
- `COMPLETE` requires verification success and an immutable linked receipt.
- No HTTP/API/MCP/CLI listener or production deployment is part of this increment.

---

### Task 1: Define transactional-store behavior with failing tests

**Files:**
- Create: `tests/sqlite-job-store.test.js`

**Interfaces:**
- Consumes: existing `validateJobRecord`, `assertJobTransition`, `safeDurableClone`, `validateExecutionOwnership`.
- Produces test contract for `SQLiteJobStore` methods defined in Tasks 2-5.

- [ ] Write tests proving two writers using the same `expectedStateVersion` cannot both commit.
- [ ] Write tests proving an old `executionEpoch` cannot persist a checkpoint after ownership is reacquired.
- [ ] Write tests proving checkpoint and cumulative counts advance in one transaction.
- [ ] Write tests proving `RECOVERY_REQUIRED` blocks checkpoint advancement.
- [ ] Write tests proving divergent writes to one `receiptId` cannot overwrite prior evidence.
- [ ] Write tests proving `finalizeVerifiedJob()` is idempotent and cannot create `COMPLETE` without a matching verified receipt.
- [ ] Write tests proving startup recovery converts orphan active states to `RECOVERY_REQUIRED` and clears execution ownership.
- [ ] Run the full release gate and confirm RED failures are caused only by the missing `SQLiteJobStore` implementation.

### Task 2: Add SQLite schema and durable open policy

**Files:**
- Create: `src/daemon/sqlite-job-store.js`

**Interfaces:**
- Produces: `new SQLiteJobStore({ stateDir, dbPath? })`, `close()`.

- [ ] Open `${stateDir}/spool-state.sqlite3` by default and create the parent directory with mode `0700`.
- [ ] Configure `PRAGMA foreign_keys=ON`, `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=FULL`, and `PRAGMA busy_timeout=5000`.
- [ ] Use `PRAGMA user_version=1` for the first schema.
- [ ] Create `jobs`, `receipts`, and append-only `recovery_events` tables. Store queryable CAS columns (`state_version`, `execution_epoch`, `state`, plan identity, lease fields) plus canonical JSON payloads.
- [ ] Validate parsed rows with existing runtime contracts before returning them.

### Task 3: Implement CAS mutation and execution leases

**Files:**
- Modify: `src/daemon/sqlite-job-store.js`

**Interfaces:**
- Produces: `create(plan)`, `load(jobId)`, `list()`, `update(jobId, updater, options)`, `acquireExecution(jobId, { expectedStateVersion, ownerId, leaseMs })`, `releaseExecution(jobId, { expectedStateVersion, expectedExecutionEpoch })`.

- [ ] Wrap mutations in `BEGIN IMMEDIATE` / `COMMIT` with rollback on error.
- [ ] `update()` must use SQL CAS predicates on `job_id`, previous `state_version`, and expected execution epoch when supplied; a zero-row update fails `STALE_STATE_VERSION` or `STALE_EXECUTION_EPOCH` rather than overwriting a newer writer.
- [ ] `acquireExecution()` increments `executionEpoch`, records bounded owner/lease metadata, and refuses takeover of an unexpired lease owned by another runner.
- [ ] Expired takeover of an active state must move the job to `RECOVERING`, never assume the previous target operation rolled back.
- [ ] `releaseExecution()` clears owner/lease metadata while retaining the epoch as a fence against stale processes.

### Task 4: Add atomic checkpoint and recovery evidence primitives

**Files:**
- Modify: `src/daemon/sqlite-job-store.js`

**Interfaces:**
- Produces: `commitCheckpoint(jobId, checkpoint, { expectedStateVersion, expectedExecutionEpoch })`, `appendRecoveryEvent(jobId, event)`, `recoverInterruptedJobs()`.

- [ ] `commitCheckpoint()` rejects `RECOVERY_REQUIRED`, validates plan identity and counters, and commits job checkpoint + cumulative counts in the same transaction.
- [ ] Recovery events contain bounded metadata/hashes only and pass `safeDurableClone()` before insertion.
- [ ] `recoverInterruptedJobs()` transactionally moves orphan `RUNNING`, `PAUSING`, and `VERIFYING` jobs to `RECOVERY_REQUIRED`, increments their state version, clears lease owner/deadline, and appends a recovery event. It must not alter terminal jobs.

### Task 5: Make receipt persistence and terminal completion recoverable

**Files:**
- Modify: `src/daemon/sqlite-job-store.js`

**Interfaces:**
- Produces: `saveReceipt(receipt)`, `loadReceipt(receiptId)`, `finalizeVerifiedJob(jobId, receipt, { expectedStateVersion, expectedExecutionEpoch })`.

- [ ] `saveReceipt()` inserts by primary key. Existing byte/canonical-equivalent content is idempotent; divergent content fails `RECEIPT_IMMUTABLE`.
- [ ] `finalizeVerifiedJob()` runs receipt insertion and job transition in one SQLite transaction.
- [ ] Validate receipt `jobId`, `planId`, `planRevision`, `terminalStatus`, counts, and verification evidence against the prospective completed job.
- [ ] A repeated finalization returning the same linked receipt is idempotent; any divergent terminal receipt fails closed.

### Task 6: Verify compatibility and production safety

**Files:**
- No browser/runtime-surface changes expected.

- [ ] Run `npm test` and require all tests green.
- [ ] Run `npm run build`.
- [ ] Run `npm run benchmark`.
- [ ] Run `node scripts/static-check.js`.
- [ ] Verify the existing file-backed `JobStore`, browser kernel, WebMCP tests, and connectors remain green.
- [ ] Inspect the live Vercel production deployment and runtime errors; do not deploy this daemon-only increment.
- [ ] Keep PR #3 draft/unmerged and report the exact final head and release-gate result.
