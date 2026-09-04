# P1 JobStore Concurrency and Durability Audit

Date: 2026-09-05
Status: audit/design evidence only; no architectural implementation authorized

## Gate

`2026-09-05-hybrid-local-bridge-platform-design.md` still records `written-spec review pending`. Under the explicit project instruction, this audit does not authorize changes to daemon/runtime architecture, connector behavior, API/MCP/CLI surfaces, deployment configuration, or production CSP/network boundaries.

## Scope

Audit the current `src/daemon/job-store.js`, receipt persistence behavior, and `tests/job-store.test.js` against the crash-recovery contract in `2026-09-05-p1-crash-recovery-failure-matrix.md`.

The goal is to identify the smallest correctness delta that must be closed after explicit written-spec approval, before a shared runner or `spoold` is allowed to depend on the JobStore.

## Executive finding

The current JobStore is useful as an early persistence scaffold, but it is not yet a safe daemon execution store for concurrent/restartable source-to-target jobs.

The main blockers are:

1. read-modify-write updates have no optimistic concurrency control;
2. there is no execution lease/epoch, so stale runners cannot be fenced;
3. `RECOVERING` and `RECOVERY_REQUIRED` are absent from the implemented state model;
4. the metadata write path does not prove crash durability with file + directory sync semantics;
5. receipt immutability is not race-safe across processes;
6. job completion requires `verification.ok === true` but does not require an immutable, durably linked receipt;
7. receipt persistence and job terminal transition are not one recoverable linkage protocol;
8. checkpoint counters and top-level job counters are allowed to diverge;
9. existing restart coverage is process re-instantiation, not fault-injected crash/commit ambiguity testing.

These are correctness issues, not feature polish. A runner should not be built on top of the current store until they are resolved or explicitly constrained by the approved implementation plan.

## Evidence and failure modes

### 1. Lost update / duplicate-runner race

`JobStore.update()` currently performs:

```text
load current JSON
-> call updater
-> validate candidate
-> rename replacement JSON over current JSON
```

There is no `stateVersion`, expected-version compare-and-swap, lock, lease, or execution epoch.

Two daemon processes can therefore load the same state, each produce a valid next state, and the later rename can silently replace the earlier committed metadata update.

This violates the crash-recovery requirement that stale runners cannot persist checkpoints after execution ownership moves.

Required post-approval property:

```text
UPDATE job
WHERE jobId = ?
  AND stateVersion = expectedVersion
  AND executionEpoch = expectedEpoch
```

or an equivalent transactionally enforced compare-and-swap.

### 2. No stale-runner fencing

The recovery design requires a durable execution epoch/lease. The current job record contains no owner identity, execution epoch, lease deadline, heartbeat generation, or state version.

A process-local mutex would not be enough because the target deployment model includes daemon restart, multiple local instances, CI, VM/container restart, and self-hosted orchestration.

Required post-approval property: metadata writes from an old runner are rejected after ownership transfers, without assuming the old runner's target transaction rolled back.

### 3. Recovery state model mismatch

The current transition table contains:

```text
PLANNED
RUNNING
PAUSING
PAUSED
VERIFYING
COMPLETE
FAILED
ABORTED
```

The reviewed crash matrix requires explicit non-terminal states:

```text
RECOVERING
RECOVERY_REQUIRED
```

Without these states, an ambiguous target commit has no safe representational home other than incorrectly retrying, pausing, or terminally failing.

Required post-approval property: ambiguous commit/checkpoint boundaries become non-writing recovery states until reconciliation proves a continuation boundary.

### 4. Metadata durability is atomic-replace, not yet crash-durable

`atomicWrite()` creates a temporary file and renames it over the destination. This protects against many torn-write cases but does not by itself establish the stronger crash durability expected by the recovery design.

The current path does not explicitly:

- sync the newly written file before rename;
- sync the containing directory after rename where the platform/filesystem requires it;
- persist a transaction journal tying job/checkpoint/receipt linkage together.

Required post-approval property: once SPOOL reports a checkpoint/terminal metadata mutation committed, recovery can rely on that claim after process and machine-level interruption within the supported platform contract.

### 5. Receipt immutability has a cross-process race

`saveReceipt()` checks whether the final receipt file already exists. If it does, divergent content is rejected. If it does not, the method writes a temp file and renames it to the final path.

Two processes can both observe `ENOENT`, create different temp files for the same `receiptId`, and race the final rename. On filesystems where rename replaces the destination, the second write can replace the first despite the intended immutability check.

Even if canonical receipt IDs normally make divergent content unlikely, persistence must enforce the invariant rather than depend on callers behaving correctly.

Required post-approval property: receipt insert is create-once/content-addressed under a transaction or an exclusive final creation primitive; divergent content for an existing `receiptId` can never replace prior evidence.

### 6. `COMPLETE` is not coupled to receipt durability

The current validation prevents `COMPLETE` unless `verification.ok === true`, which is good. It does not require `receiptId` to exist, and no transaction proves that the referenced immutable receipt is durably present before the terminal state is committed.

The crash matrix explicitly requires:

```text
verified target
-> immutable receipt persisted
-> job terminal linkage committed
```

with restart reconciliation if the process dies between those boundaries.

Required post-approval property: a job cannot become `COMPLETE` unless it is linked to a valid immutable receipt whose identity/content matches that job, plan, verification evidence, and terminal status.

### 7. No receipt/job linkage reconciliation

There is currently no store primitive equivalent to:

```text
finalizeVerifiedJob(job, receipt)
```

that atomically or recoverably establishes both receipt persistence and terminal job linkage.

A crash after receipt creation but before job update can leave an orphan receipt. A crash after job terminal mutation but before receipt creation could create a terminal job without durable evidence if a caller sequences operations incorrectly.

Required post-approval property: repeated finalization is idempotent, and restart can reconcile either side without creating a divergent second receipt.

### 8. Checkpoint and job counters can diverge

`validateCheckpoint()` prevents a checkpoint from moving behind persisted job counts, but it does not require checkpoint counters to equal the job counters that represent the same durable boundary.

The current restart test persists a checkpoint at 500 processed rows while leaving the top-level job counts at their original zero values.

That creates two persisted representations of progress with different values.

Required post-approval property: committed cumulative counters have one canonical durable value, or the schema explicitly defines which representation is authoritative and derives the other rather than allowing divergence.

### 9. Current tests do not exercise crash ambiguity

The existing restart test constructs a second `JobStore` instance and verifies that a PAUSED checkpoint can be reloaded. That proves basic persistence, not crash correctness.

Missing evidence includes:

- concurrent update conflict rejection;
- stale execution epoch rejection;
- crash after target commit before checkpoint;
- crash after checkpoint before next source read;
- commit-response ambiguity;
- receipt insert before terminal link;
- duplicate/divergent concurrent receipt persistence;
- source/target/plan drift on resume;
- injected secret-bearing exceptions during recovery;
- machine/filesystem interruption assumptions for metadata durability.

## Required post-approval increment

Before implementing the shared runner or exposing the store through `spoold`, the next architectural increment should convert the persistence scaffold into a transactional durable execution store with these minimum properties:

1. durable schema versioning/migrations;
2. optimistic `stateVersion` on every job mutation;
3. execution epoch + lease/ownership fencing;
4. `RECOVERING` and `RECOVERY_REQUIRED` transitions;
5. transactionally consistent checkpoint + counts;
6. immutable receipt insertion enforced by storage;
7. recoverable/transactional receipt-to-job terminal linkage;
8. append-only recovery/incident evidence where target outcome is ambiguous;
9. restart reconciliation by plan/source/target/connector identities;
10. fault-injection and multi-runner tests before command service or daemon endpoints depend on it.

The previously proposed SQLite metadata store is a strong fit for these requirements because transactions, uniqueness constraints, compare-and-swap predicates, WAL/recovery behavior, and relational linkage are materially safer than coordinating multiple JSON replacement files. The exact SQLite schema and durability pragmas should be specified and tested rather than assumed.

## Acceptance tests for that increment

After explicit written-spec approval, the persistence increment should not be considered complete until automated tests prove at least:

- two writers using the same expected `stateVersion` cannot both commit;
- a stale execution epoch cannot advance state/checkpoint;
- checkpoint, cumulative counts, and target boundary commit together;
- `RECOVERY_REQUIRED` blocks further write execution;
- concurrent divergent receipt creation cannot overwrite existing evidence;
- `COMPLETE` without a durably linked verified receipt is rejected;
- finalization is idempotent after crash between receipt persistence and terminal linkage;
- source/target/plan identity drift blocks resume;
- corrupted metadata is detected and fails closed;
- secret values/raw rows remain absent from jobs, receipts, logs, and projected recovery errors;
- all existing browser/WebMCP/release-gate tests stay green.

## Current safe decision

Do not add shared runner, `spoold`, API, MCP, CLI, self-hosted server, or additional architectural runtime behavior on top of the present JobStore while the written architecture approval gate is pending.

The next implementation priority after explicit approval should be the transactional durable JobStore/recovery contract, not more outward-facing interfaces. That reduces the risk of exposing a daemon/API around persistence semantics that later need breaking changes.