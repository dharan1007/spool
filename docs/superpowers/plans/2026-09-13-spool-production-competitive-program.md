# SPOOL Production + Competitive Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn SPOOL from a narrow verified-mutation runtime into a real-world production database migration and continuous verified mutation platform that preserves SVMP correctness while reaching practical parity with mature migration/CDC systems and exceeding them on authorization, reconciliation, verification, evidence, and agent-safe external mutation.

**Architecture:** Keep SVMP as the invariant-bearing correctness layer and make every connector/runtime prove a declared assurance level C0-C6. Build PostgreSQL to full offline migration first, then add scalable verification, CDC and cutover, then distributed execution, additional databases, and a hosted enterprise control plane. Do not broaden connector count until the PostgreSQL reference implementation passes crash, correctness, scale, security, and cutover qualification.

**Tech Stack:** Node.js 22+, PostgreSQL 14-18 reference target/source, `pg` initially plus native PostgreSQL COPY/replication support where necessary, SQLite for local state where appropriate, PostgreSQL for distributed control-plane state, WebMCP/HTTP/CLI surfaces, deterministic canonical JSON + SHA-256 identities, GitHub Actions, Vercel for Browser Studio, OpenTelemetry for observability, standard secret managers/KMS via provider adapters.

**Spec:** `models/SVMP.md`, `docs/ARCHITECTURE.md`, `docs/LOCAL_RUNNER.md`, current connector assurance contract, and this program plan.

## Global Constraints

- No synthetic success, fake production readiness, hidden retry ambiguity, or connector assurance overclaiming.
- No external mutation unless source/plan/target/authority/execution identities are bound and the target connector meets the minimum required assurance.
- No blind retry after unknown non-idempotent outcome.
- No checkpoint advancement before exact target commit evidence or an explicitly defined weaker assurance path.
- No secrets in plans, model-visible tool arguments, receipts, logs, or durable workflow payloads; persist credential references only.
- No arbitrary JavaScript/eval/shell transformation escape hatch.
- Every destructive or repair mutation requires a distinct approval bound to exact semantics and target identity.
- Every production release must prove exact Git SHA parity and deployed artifact integrity before claims are updated.
- PostgreSQL is the reference C6 implementation. MySQL/SQL Server may reuse the protocol only after PostgreSQL gates are green.
- Correctness gates dominate performance. Optimize only after profiling and after invariant-preserving tests exist.
- Use TDD for every new safety, recovery, protocol, connector, and scheduler behavior.

---

## Program dependency graph

```text
P0 Release truth + current verification repair
            │
            ▼
P1 Repair execution semantics + SVMP evidence
            │
            ▼
P2 PostgreSQL full-database discovery/snapshot/schema graph
            │
            ├──────────────► P3 Full PostgreSQL type system
            │                         │
            └──────────────► P4 Schema/DDL migration
                                      │
                                      ▼
                          P5 High-throughput bulk load
                                      │
                                      ▼
                          P6 Scalable verification/repair
                                      │
                                      ▼
                          P7 PostgreSQL logical CDC
                                      │
                                      ▼
                          P8 Zero-downtime cutover/failback
                                      │
                                      ▼
                          P9 C6 conformance + chaos qualification
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
          P10 Distributed fleet              P11 MySQL / SQL Server
                    │                                   │
                    └─────────────────┬─────────────────┘
                                      ▼
                          P12 Enterprise control plane
                                      │
                                      ▼
                          P13 SPOOL-Bench + release GA
```

---

### Task 0: Restore release truth and finish protocol-level exact verification

**Files:**
- Modify: `src/execution/content-verification-manifest.js`
- Modify: `src/daemon/command-service.js`
- Modify: `src/connectors/postgres/content-verification.js`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/production-smoke.yml`
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Test: `tests/content-verification-manifest.test.js`
- Test: `tests/run-store-content-verification.test.js`
- Test: `tests/conformance/postgres-command-source-conformance.test.js`

**Interfaces:**
- Consumes: existing `verifyContentProjection()`, `createRepairPlan()`, `RunStore`, PostgreSQL repeatable-read verifier.
- Produces: restart-safe `content_exact` protocol verification, durable per-batch compact evidence, and a release pipeline that refuses stale deployment SHA.

- [ ] Reproduce PR #50's three `INVALID_CONTENT_VERIFICATION_EVIDENCE` failures locally/CI and freeze failing fixtures.
- [ ] Define one canonical verification-batch evidence schema: `ordinal`, `sourceRange`, `verificationId`, expected/actual roots, mismatch counts, targetReadState identity, repairPlanId/null.
- [ ] Make the manifest accumulator reject gaps, overlaps, duplicate ordinals, changed projection schema, changed target read snapshot, and conflicting replay.
- [ ] Persist only hashes/counts/repair identity in run state; never retain whole verified row payloads in durable manifest state.
- [ ] Ensure `content_exact` failure prevents final receipt creation and yields an explicit terminal verification failure state.
- [ ] Require a new separately bound repair approval before any generated repair plan can mutate a target.
- [ ] Run `npm test` and the real PostgreSQL conformance job with a live ephemeral PostgreSQL service; no PostgreSQL production tests may be skipped in the dedicated connector gate.
- [ ] Restore Vercel Git/deployment authority so canonical production deploys current main automatically or through an authenticated source-bound CI deployment.
- [ ] Make production smoke verify `/release.json`, manifest root, every artifact digest, canonical domain, and exact expected SHA.
- [ ] Require release gate + PostgreSQL conformance + production smoke before a production release tag can publish.

**Exit gate:** exact-content verification is restart-safe and deterministic; no receipt is possible on content diff; canonical Vercel reports the exact current release SHA; README claims match deployed reality.

---

### Task 1: Turn repair planning into a complete verified repair lifecycle

**Files:**
- Modify: `src/execution/repair-plan.js`
- Create: `src/execution/repair-identity.js`
- Create: `src/execution/repair-runner.js`
- Create: `src/execution/repair-verify.js`
- Modify: `src/platform/approval.js`
- Modify: `src/daemon/command-service.js`
- Modify: `src/connectors/postgres/runtime.js`
- Test: `tests/repair-lifecycle.test.js`
- Test: `tests/conformance/postgres-repair-conformance.test.js`

**Interfaces:**
- Consumes: exact verification diff, plan/source/target identities, target fencing, existing approval evidence.
- Produces: `RepairPlan`, `RepairApproval`, `RepairExecution`, `RepairVerification`, `RepairReceipt`.

- [ ] Define deterministic repair operations: `INSERT_MISSING`, `UPDATE_MISMATCH`, `DELETE_UNEXPECTED`; default `DELETE_UNEXPECTED` to disabled unless explicitly allowed.
- [ ] Bind each repair operation to original verification ID, primary-key identity, expected row hash, actual row hash/null, target contract ID, and repair policy.
- [ ] Make repair plan IDs canonical and independent of volatile timestamps.
- [ ] Add repair-specific effects to approval binding; original migration approval must not authorize repairs.
- [ ] Implement target-native transactional repair batches with the same ledger, fencing, commit evidence and reconciliation semantics as migration batches.
- [ ] Re-read repaired rows and require post-repair exact verification before issuing a repair receipt.
- [ ] Add commit-before-checkpoint and commit-before-response fault tests for repairs.
- [ ] Add adversarial tests: stale repair against changed row, changed target contract, reused repair ID with changed payload, expired approval, stale fencing token.

**Exit gate:** SPOOL can prove `verification diff -> deterministic repair plan -> separately authorized repair -> reconciled commit -> exact re-verification` without mutating unrelated rows.

---

### Task 2: Build PostgreSQL full-database discovery and one database-level consistent snapshot

**Files:**
- Create: `src/connectors/postgres/catalog.js`
- Create: `src/connectors/postgres/database-snapshot.js`
- Create: `src/connectors/postgres/schema-graph.js`
- Create: `src/connectors/postgres/table-source.js`
- Modify: `src/connectors/postgres/source.js`
- Modify: `src/daemon/durable-source.js`
- Create: `tests/conformance/postgres-database-snapshot.test.js`
- Create: `tests/conformance/postgres-schema-graph.test.js`

**Interfaces:**
- Produces: `PostgresDatabaseState`, `SchemaGraph`, and per-table streams all bound to one source database snapshot/WAL position.

- [ ] Catalog schemas, ordinary/partitioned tables, columns, PK/UK, FKs, checks, indexes, sequences/identity, generated columns, partitions, enums/domains, views/materialized views, collations and extension/type dependencies.
- [ ] Distinguish supported, ignored and blocking database objects explicitly; unsupported objects must appear in preflight, not silently disappear.
- [ ] Open one database-level repeatable-read snapshot and ensure every table copy is tied to that snapshot rather than opening unrelated per-table snapshots.
- [ ] Persist a canonical database SourceState containing server/database identity, snapshot identity, WAL LSN, catalog hash and selected-object graph hash.
- [ ] Generate deterministic table ordering from the dependency graph while separating data-load ordering from later constraint/index creation.
- [ ] Add table selection/exclusion policy with canonical identity; selection changes must change the plan ID.
- [ ] Add tests with 50+ related tables, composite keys, partitions, sequences and cross-schema FKs proving all streams reflect one logical source state.

**Exit gate:** one migration can represent an entire selected PostgreSQL database as one immutable logical source state.

---

### Task 3: Implement full PostgreSQL value/type semantics

**Files:**
- Create: `src/connectors/postgres/types/catalog.js`
- Create: `src/connectors/postgres/types/encode.js`
- Create: `src/connectors/postgres/types/normalize.js`
- Create: `src/connectors/postgres/types/compare.js`
- Modify: `src/connectors/postgres/preflight.js`
- Modify: `src/connectors/postgres/target.js`
- Modify: `src/connectors/postgres/content-verification.js`
- Test: `tests/conformance/postgres-types.test.js`

**Interfaces:**
- Produces: deterministic type descriptors and value codecs used identically by snapshot, write, verification and repair paths.

- [ ] Support integer families, numeric/decimal without precision loss, real/double explicit semantics, boolean, text/varchar/char, UUID, date, time, timetz, timestamp, timestamptz, interval, bytea, JSON/JSONB, arrays, enums, domains and inet/cidr.
- [ ] Preserve exact decimal representation; do not convert arbitrary PostgreSQL numeric to JS Number.
- [ ] Normalize timestamp semantics explicitly; timezone-free and instant values must remain different semantic types.
- [ ] Define deterministic JSON/JSONB comparison semantics and binary-safe bytea hashing.
- [ ] Discover extension/custom types and fail preflight unless an explicit codec/adapter exists.
- [ ] Build round-trip fixtures containing nulls, extremes, Unicode, NaN/Infinity where PostgreSQL permits them, large JSON, arrays and binary payloads.
- [ ] Differentially test `source -> target -> readback -> canonical compare` for every supported type.

**Exit gate:** no supported PostgreSQL value type changes meaning due to JavaScript coercion or verifier normalization.

---

### Task 4: Build schema/DDL migration as a separately verified effect class

**Files:**
- Create: `src/execution/schema-plan.js`
- Create: `src/execution/schema-diff.js`
- Create: `src/connectors/postgres/schema-executor.js`
- Create: `src/connectors/postgres/schema-verify.js`
- Modify: `src/platform/plan.js`
- Modify: `models/SVMP.md`
- Test: `tests/schema-plan.test.js`
- Test: `tests/conformance/postgres-schema-migration.test.js`

**Interfaces:**
- Produces: canonical `SchemaPlan` with ordered DDL effects, risk level and required approvals.

- [ ] Compute source-vs-target schema graph diff without generating SQL first.
- [ ] Classify operations: create schema/type/table/sequence/index/constraint; widen-compatible alteration; rewrite-heavy alteration; destructive drop/truncate; unsupported/manual.
- [ ] Require distinct approval classes for destructive DDL and data rewrites.
- [ ] Execute safe DDL using parameterized/quoted identifiers and explicit transaction boundaries where PostgreSQL supports them.
- [ ] Separate bulk-load preparation from final integrity objects: create tables/types first, load data, then indexes/FKs/checks where policy permits.
- [ ] Synchronize sequence/identity values after load and verify next-value correctness.
- [ ] Re-introspect the live target and require target schema graph equality before schema phase is VERIFIED.

**Exit gate:** SPOOL can create or reconcile a target schema deterministically instead of requiring an already-perfect target table.

---

### Task 5: Build production high-throughput PostgreSQL bulk load

**Files:**
- Create: `src/connectors/postgres/copy-writer.js`
- Create: `src/execution/partition-plan.js`
- Create: `src/execution/backpressure.js`
- Modify: `src/connectors/postgres/target.js`
- Modify: `src/execution/migration-runner.js`
- Test: `tests/conformance/postgres-copy-load.test.js`
- Create: `benchmarks/postgres-bulk-load.js`

**Interfaces:**
- Produces: bulk writer with the same batch/effect identity semantics as row-wise writes.

- [ ] Use PostgreSQL `COPY FROM STDIN` for eligible bulk-load partitions; keep row-wise INSERT for small/repair/control operations.
- [ ] Define chunk/partition identities so COPY segments are resumable and reconcilable without treating a half-written stream as committed.
- [ ] Commit target data plus exact SPOOL partition evidence transactionally or use a staged table + atomic finalize pattern when necessary.
- [ ] Add adaptive batch sizing based on observed latency/memory while preserving deterministic partition boundaries in the approved plan.
- [ ] Add provider/database backpressure from lock waits, transaction latency, WAL pressure and target errors.
- [ ] Parallelize independent tables and safe slices; never parallelize across FK/ordering constraints without a declared strategy.
- [ ] Benchmark 1M/10M/100M rows and record rows/s, MB/s, CPU, peak memory, WAL growth, target bloat and evidence overhead.

**Exit gate:** bulk load is practical at hundreds of GB while preserving exact mutation identities and restart semantics.

---

### Task 6: Replace O(N) full verification with hierarchical scalable verification

**Files:**
- Create: `src/execution/verification-tree.js`
- Create: `src/execution/range-partitioner.js`
- Create: `src/connectors/postgres/range-verification.js`
- Modify: `src/execution/content-verification.js`
- Modify: `src/execution/repair-plan.js`
- Test: `tests/verification-tree.test.js`
- Test: `tests/conformance/postgres-range-verification.test.js`

**Interfaces:**
- Produces: `VerificationTree` containing table/range roots and exact leaf diffs only for mismatching regions.

- [ ] Partition tables by stable PK ranges; support composite keys and deterministic split boundaries.
- [ ] Compute canonical range summaries from source and target with row counts + canonical content roots.
- [ ] If roots match, close the range without transferring all row payloads.
- [ ] If roots differ, recursively subdivide until configured leaf size, then perform exact row-wise comparison.
- [ ] Persist compact proof tree nodes so verification resumes after worker/process failure.
- [ ] Bind generated repairs to mismatch leaf proof IDs.
- [ ] Support online verification by recording source and target read positions/snapshots so moving data is not compared across unrelated logical moments.
- [ ] Qualification: 1B logical rows in synthetic/partitioned benchmark must not require 1B durable evidence records.

**Exit gate:** verification cost scales with table/range summaries plus actual differences, not always with total row payload transfer.

---

### Task 7: Build PostgreSQL logical replication CDC correctly

**Files:**
- Create: `src/connectors/postgres/cdc/slot.js`
- Create: `src/connectors/postgres/cdc/publication.js`
- Create: `src/connectors/postgres/cdc/stream.js`
- Create: `src/connectors/postgres/cdc/transaction.js`
- Create: `src/connectors/postgres/cdc/checkpoint.js`
- Create: `src/connectors/postgres/cdc/apply.js`
- Create: `src/connectors/postgres/cdc/health.js`
- Modify: `src/connectors/contract.js`
- Modify: `models/SVMP.md`
- Test: `tests/conformance/postgres-cdc.test.js`

**Interfaces:**
- Produces: ordered `ChangeTransaction` envelopes with source LSN identity and restart-safe apply checkpoints.

- [ ] Use PostgreSQL logical replication/`pgoutput`; manage unique publication and replication slot identity per migration/consumer.
- [ ] Capture snapshot start and CDC start LSN so no writes are lost between full-load snapshot and change stream.
- [ ] Preserve source transaction boundaries and commit order; batch internally only where this cannot change semantics.
- [ ] Handle INSERT/UPDATE/DELETE and primary-key changes explicitly; require replica identity/PK capability for safe update/delete or fail preflight.
- [ ] Persist last proven source LSN only after corresponding target effects are proven committed.
- [ ] Add target transaction ledger entries keyed by source transaction identity/LSN range.
- [ ] On response loss, reconcile target ledger before replaying a transaction.
- [ ] Monitor slot WAL retention, inactivity, source failover, publication drift and offset/slot mismatches; surface hard blocking states instead of silently resetting offsets.
- [ ] Test connector restarts, source restarts, network partitions, duplicate delivery, lost ACK, large transaction, transaction rollback, long-running transaction and slot retention pressure.

**Exit gate:** full-load + CDC can run continuously without missed committed source changes or blind duplicate target effects.

---

### Task 8: Build zero-downtime cutover and failback

**Files:**
- Create: `src/execution/cutover-plan.js`
- Create: `src/execution/cutover-state-machine.js`
- Create: `src/execution/failback-plan.js`
- Modify: `src/daemon/command-service.js`
- Modify: `models/SVMP.md`
- Test: `tests/cutover-state-machine.test.js`
- Test: `tests/conformance/postgres-cutover.test.js`

**Interfaces:**
- Produces: explicit `CutoverAuthority`, cutover receipt and optional failback window state.

- [ ] Define states: `COPYING -> CATCHING_UP -> CUTOVER_READY -> WRITE_FREEZE_REQUIRED -> FINAL_CATCHUP -> FINAL_VERIFY -> PROMOTED` plus abort/failback states.
- [ ] Define objective readiness metrics: replication lag bytes/time, outstanding transactions, verification status, schema parity, target health.
- [ ] Require a separate cutover approval bound to exact source/target/LSN state and maximum allowed lag.
- [ ] Provide hooks for application write freeze/read-only transition; do not pretend SPOOL can freeze arbitrary applications automatically.
- [ ] Consume through the final source commit, verify zero outstanding CDC, run final high-confidence verification, then emit promotion authority/receipt.
- [ ] Support a bounded failback window through reverse CDC only after explicit configuration; otherwise document one-way promotion.
- [ ] Fault tests at every transition: source resumes writes too early, target failover, worker death, stale cutover token, final verification diff.

**Exit gate:** SPOOL can execute and prove a controlled minimal-downtime PostgreSQL cutover without losing the final write window.

---

### Task 9: Define and enforce C6 continuous verified mutation

**Files:**
- Modify: `src/connectors/contract.js`
- Modify: `src/connectors/registry.js`
- Modify: `models/SVMP.md`
- Create: `src/protocol/c6-conformance.js`
- Create: `tests/conformance/c6-contract.test.js`

**Interfaces:**
- Produces: machine-enforced C6 capability/behavior contract.

- [ ] Require C6 connector claims to prove C1 snapshot, C4 transaction-bound/fenced target path, restart-safe CDC position, change ordering, source-to-target transaction identity, read-after-write verification and drift policy.
- [ ] Add capability requirements for `continuousChangeCapture`, `transactionBoundaryCapture`, `restartSafeChangePosition`, `schemaDriftDetection`, `cutoverEvidence` and `continuousVerification`.
- [ ] Build a reusable connector conformance suite with injected duplicate changes, commit-before-ack, stale workers, target drift and source offset loss.
- [ ] Refuse C6 registration when any mandatory property is absent.

**Exit gate:** C6 is an executable certification boundary, not a marketing label.

---

### Task 10: Build a distributed worker fleet without weakening fencing

**Files:**
- Create: `src/distributed/postgres-work-store.js`
- Create: `src/distributed/scheduler.js`
- Create: `src/distributed/worker.js`
- Create: `src/distributed/heartbeat.js`
- Create: `src/distributed/quota.js`
- Create: `src/distributed/provider-limiter.js`
- Create: `src/distributed/dlq.js`
- Test: `tests/distributed/scheduler.test.js`
- Test: `tests/distributed/fencing.test.js`
- Test: `tests/distributed/chaos.test.js`

**Interfaces:**
- Produces: multi-host work queue with leases and monotonic fencing token per mutation resource.

- [ ] Use PostgreSQL queue/control tables with `SELECT ... FOR UPDATE SKIP LOCKED` or equivalent transactional claim semantics.
- [ ] Work item identity must include migration/run, stage, table/partition, attempt, available-at and required connector capability.
- [ ] Every takeover increments a fencing generation; stale worker commits must be rejected at the target, not only the scheduler.
- [ ] Add heartbeats, lease renewal, deterministic retry policy, max attempts and dead-letter state.
- [ ] Add tenant/project quotas, per-source/target connection budgets and provider throttling.
- [ ] Add graceful drain/deploy behavior so workers can be replaced during long migrations.
- [ ] Test with 2/10/100 concurrent worker processes, forced process kills and delayed stale commits.

**Exit gate:** a worker can die or a deployment can occur during a multi-hour migration without duplicate effects, lost work or two valid owners.

---

### Task 11: Add MySQL and SQL Server as assurance-certified connectors

**Files:**
- Create: `src/connectors/mysql/*`
- Create: `src/connectors/sqlserver/*`
- Reuse: `tests/conformance/connector-c1-c6-harness.js`

**Interfaces:**
- Each connector must advertise only the highest assurance it passes.

- [ ] MySQL offline: repeatable consistent snapshot, catalog/schema graph, full type codec, bulk load, exact verification and target reconciliation.
- [ ] MySQL CDC: GTID/binlog identity, transaction boundaries, deletes/updates, schema drift, restart-safe position and cutover.
- [ ] SQL Server offline: transactionally meaningful snapshot strategy, catalog graph, types, bulk copy and exact verification.
- [ ] SQL Server CDC: LSN/change identity, transaction/order semantics, restart/cutover proof.
- [ ] Do not claim C6 until the shared C6 suite plus engine-specific chaos suite passes.

**Exit gate:** PostgreSQL, MySQL and SQL Server each provide independently proven assurance levels, not a shared generic wrapper with untested semantics.

---

### Task 12: Build the enterprise hosted control plane with private data planes

**Files:**
- Create: `src/control-plane/*` or split into a dedicated service/package once boundaries are fixed.
- Create: `docs/enterprise/SECURITY_MODEL.md`
- Create: `docs/enterprise/OPERATIONS.md`
- Create: `docs/enterprise/DR.md`

**Interfaces:**
- Control plane stores metadata/policy/identities only; customer workers retain raw source/target access where configured.

- [ ] Org/project/environment hierarchy with immutable IDs.
- [ ] OIDC/SAML SSO and SCIM lifecycle.
- [ ] RBAC plus resource/effect-scoped ABAC policy for approvals and agent actions.
- [ ] Service principals/workload identity for unattended verified workflows.
- [ ] Secret-provider adapters: AWS Secrets Manager/KMS, GCP Secret Manager/KMS, Azure Key Vault, HashiCorp Vault; never mirror raw secret values into workflow state.
- [ ] Private/BYOC workers with outbound-only authenticated control channels and short-lived workload credentials.
- [ ] Immutable audit log for policy, approval, execution, repair, cutover and administrative changes.
- [ ] OpenTelemetry traces/metrics/logs keyed by migration/run/partition without including row contents/secrets.
- [ ] Backup/restore and DR for control-plane state; define RPO/RTO and test them.
- [ ] Quotas, usage accounting, tenant isolation tests and noisy-neighbor load tests.
- [ ] Security review: SSRF, path traversal, connector privilege scope, SQL injection, secret exfiltration, confused deputy, replay, stale authorization, multi-tenant IDOR.

**Exit gate:** an enterprise can run SPOOL workers in its network while the control plane manages policy, status and evidence without requiring raw production rows to leave the customer's boundary.

---

### Task 13: Create SPOOL-Bench and release only on reproducible competitive evidence

**Files:**
- Create: `benchmarks/spool-bench/README.md`
- Create: `benchmarks/spool-bench/scenarios/*.json`
- Create: `benchmarks/spool-bench/runner.js`
- Create: `docs/BENCHMARKS.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces machine-readable benchmark result bundles tied to Git SHA, environment and scenario version.

- [ ] Scenarios: 10GB/100GB/1TB full load, 1M/100M/1B-row verification, continuous CDC, high-update hot table, large transaction, schema drift, target lock contention, target failover, source restart, network loss after target commit, stale worker after takeover, process death, disk pressure and cutover.
- [ ] Metrics: lost changes, duplicate effects, unresolved commit ambiguity, silent mismatches, recovery time, source/target load, throughput MB/s and rows/s, p95/p99 apply latency, CDC lag, verification cost, peak RAM, disk/WAL amplification, evidence bytes and cutover downtime.
- [ ] Correctness score is binary for forbidden failures: any lost committed source change, duplicate non-idempotent effect, unauthorized mutation, accepted stale fence, or falsely VERIFIED mismatch is an automatic scenario failure.
- [ ] Publish SPOOL results first. Competitor comparisons may only be published when the same reproducible workload and documented configurations are used.
- [ ] Add release qualification matrix: PostgreSQL versions, OS, local/cloud managed providers, dataset/type/schema features and known unsupported cases.

**Exit gate:** product claims are backed by reproducible evidence rather than architecture assertions.

---

## Competitive win conditions

SPOOL should not try to beat every incumbent by copying every feature. The target is asymmetric parity:

1. **Correctness/proof: win.** Stronger source/plan/target/authority/execution/evidence/verification/receipt binding than DMS/HVR/Airbyte-style normal migration workflows.
2. **Crash ambiguity: win.** No blind retry after unknown target commit; target-native reconciliation is mandatory at C4+.
3. **Agent safety: win.** Agents may propose but cannot silently broaden effects or bypass approvals/SVMP.
4. **Verification/repair: win or tie HVR.** Hierarchical online verification plus proof-bound repairs, not only checksums or generated SQL.
5. **PostgreSQL migration completeness: reach parity.** Full schema, types, COPY bulk load, multi-table dependency handling, CDC, cutover, failback policy.
6. **Scale: reach credible parity.** Distributed workers and TB qualification; no need to win every raw-throughput benchmark if correctness overhead is explicit and competitive.
7. **Connector breadth: federate rather than chase.** Build PostgreSQL/MySQL/SQL Server deeply; later provide an SDK/adapters for external ecosystems. Do not spend the core team's time cloning 600+ shallow connectors.
8. **Enterprise operation: reach parity.** SSO/SCIM/RBAC, private workers, KMS/Vault, audit, observability, HA/DR, quotas and policy.

## Real-world GA acceptance gates

SPOOL is not "enterprise production ready" until all of these are proven for the declared PostgreSQL GA scope:

- exact deployed Git SHA and artifact parity: PASS;
- all main/release checks enforced: PASS;
- zero skipped PostgreSQL production conformance tests in the dedicated database gate: PASS;
- 100GB and 1TB full-load qualification: PASS;
- multi-table database snapshot consistency under concurrent writes: PASS;
- full supported-type round trip: PASS;
- crash after target commit before SPOOL checkpoint: PASS with zero duplicates;
- unknown non-idempotent outcome: zero blind retries;
- stale worker after lease takeover: target rejects stale fence;
- process/host death during bulk load and CDC: restart PASS;
- source PostgreSQL restart: recovery PASS;
- target PostgreSQL restart/failover: recovery/reconciliation PASS where provider semantics allow;
- CDC insert/update/delete and large transactions: PASS;
- source-to-target cutover under concurrent write load: no lost committed changes;
- final exact/hierarchical verification: zero falsely VERIFIED mismatches;
- repair lifecycle: only proof-bound separately authorized rows mutate;
- source/target schema drift: fail closed or execute explicitly approved drift policy;
- 24h and 72h soak: no invariant violation;
- secrets absent from plans, logs, durable evidence and model-visible arguments;
- multi-tenant authorization/IDOR/security test suite: PASS for hosted control plane;
- backup/restore and disaster-recovery exercise: PASS;
- published SPOOL-Bench result bundle tied to release SHA.

## Build-order rule

Do not start MySQL/SQL Server or broad enterprise UI work while PostgreSQL still lacks full-load/CDC/cutover qualification. The reference implementation is the protocol proof. Every later connector should become cheaper because the C1-C6 contracts, conformance harness, verification tree, scheduler and enterprise boundaries already exist.
