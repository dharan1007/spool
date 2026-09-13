# Durable PostgreSQL Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task.

**Goal:** Make PostgreSQL source state durable across approval, restart, and recovery, then use it for verified PostgreSQL-to-PostgreSQL execution.

**Architecture:** The existing live PostgreSQL C1 source remains the acquisition layer. A new materializer writes canonical row chunks and atomically publishes a verified manifest whose root hash becomes `sourceSnapshotId`. The command service consumes this same snapshot abstraction for planning, approval, execution and recovery, while the existing C4 target kernel remains the only mutation writer.

**Tech Stack:** Node.js 22+, PostgreSQL 17 integration tests, SHA-256, canonical JSON, filesystem atomic rename/fsync, existing SPOOL SVMP/C4 target kernel.

**Spec:** `docs/superpowers/specs/2026-09-13-durable-postgres-snapshots-design.md`

## Global Constraints
- Do not reuse an expired PostgreSQL MVCC snapshot as if it were durable.
- Approval, checkpoint, batch identities, verification and receipts must bind the finalized manifest identity.
- Corrupt or missing chunks fail before target mutation.
- Preserve bounded-memory streaming.
- Existing filesystem CSV behavior must remain compatible.

### Task 1: Durable materialized snapshot core
**Files:** create `src/connectors/materialized-snapshot.js`; create `tests/materialized-snapshot.test.js`.
- [ ] Write RED tests for deterministic manifest identity, chunk verification, corruption rejection and streaming replay.
- [ ] Implement canonical NDJSON chunk writing, per-chunk hashes, atomic manifest publication and independent load/verify/replay.
- [ ] Run unit tests and full release gate.
- [ ] Commit.

### Task 2: PostgreSQL materialization
**Files:** modify `src/connectors/postgres/source.js`; create `tests/conformance/postgres-materialization-conformance.test.js`; modify `.github/workflows/ci.yml`.
- [ ] Write RED real-PostgreSQL tests proving one held MVCC snapshot materializes exact rows while concurrent source writes remain invisible.
- [ ] Add `materializeSnapshot()` to the PostgreSQL source runtime using its existing deterministic batches.
- [ ] Prove partial acquisition is not reusable as a finalized snapshot.
- [ ] Run PostgreSQL 17 conformance and release gate.
- [ ] Commit.

### Task 3: Command-service PostgreSQL source path
**Files:** modify `src/daemon/command-service.js`; add command-service integration tests.
- [ ] Add RED tests for PostgreSQL inspect/plan/approve/run using durable snapshot identity.
- [ ] Register the PostgreSQL source runtime and make prepare source-polymorphic.
- [ ] New prepare materializes; approved/restarted prepare loads exact durable snapshot by ID.
- [ ] Replay manifest rows through the existing deterministic transform/batch engine.
- [ ] Preserve filesystem behavior and C4 target requirements.
- [ ] Run full release gate and real PostgreSQL integration tests.
- [ ] Commit.

### Task 4: Restart/recovery proof
**Files:** add PostgreSQL end-to-end fault tests.
- [ ] Inject failure after manifest publication and after target COMMIT-before-checkpoint.
- [ ] Restart command service and prove exact manifest reuse, no duplicate effects, exact target-ledger reconciliation and checkpoint binding.
- [ ] Corrupt one chunk and prove failure before target lease/write.
- [ ] Commit only after green conformance.

### Task 5: Qualification and release parity
**Files:** add benchmark harness/report; update exact-SHA deployment workflow only if provenance can be proved.
- [ ] Measure bounded-memory PostgreSQL materialization/replay at a practical CI tier.
- [ ] Record throughput, peak RSS, disk bytes and verification overhead; do not publish unmeasured tiers.
- [ ] Verify source/release/artifact/deployed/smoke SHA equality. If exact deployment cannot be proven with available deployment tooling, leave it as a hard blocker rather than claiming parity.
