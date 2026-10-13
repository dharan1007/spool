# SPOOL Capability Matrix

Release: 1.1.2
Production rule: implementation + real integration test + fault test + security test + load test + benchmark evidence + documented limits.

## PRODUCTION (5)

### `filesystem.source` — Filesystem CSV source

- implementation: src/connectors/filesystem/stream-csv.js, src/daemon/durable-source.js
- integrationTests: tests/command-service-streaming.test.js, tests/e2e.test.js, tests/crm-example.test.js
- faultTests: tests/command-service-streaming-faults.test.js
- securityTests: tests/path-policy.test.js, tests/credential-broker.test.js
- loadTests: tests/streaming-memory.test.js
- benchmarks: benchmarks/run.js (migration suite)
- limits: docs/LIMITS.md#filesystem-source

_Gate B production claim; bounded-memory proof above the 50 MiB boundary._

### `sqlite.target` — SQLite target

Assurance: C4

- implementation: src/connectors/sqlite/target.js, src/connectors/sqlite/runtime.js, src/connectors/sqlite/preflight.js
- integrationTests: tests/sqlite-target.test.js, tests/conformance/sqlite-conformance.test.js
- faultTests: tests/conformance/sqlite-faults.test.js, tests/fencing.test.js, tests/crash-recovery.test.js, scripts/qualify-sqlite-production.js
- securityTests: tests/credential-broker.test.js, tests/snapshot-permissions.test.js, tests/production-connector-policy.test.js
- loadTests: scripts/qualify-sqlite-production.js
- benchmarks: benchmarks/run.js (sqliteEndToEnd suite)
- limits: docs/LIMITS.md#sqlite-target

_Bounded UTF-8 filesystem CSV to existing ordinary SQLite tables, INSERT only, 256 MiB ceiling. Windows sustained-load, 20 fault/privacy cases and 262599 assertions retained for ffb2cce0ab63d59fb5c873f9d5f591ea974a319b. Each release still requires exact-final-SHA qualification and enrolled-key signing; no cross-platform qualification claim._

### `release-integrity` — Release integrity: Git-to-dist SHA parity and per-merge evidence

- implementation: src/platform/artifact-root.js, src/platform/release-chain.js, scripts/build-dist.js, scripts/verify-release-chain.js, scripts/sign-release.js
- integrationTests: tests/release-chain.test.js, tests/artifact-root.test.js, tests/release-contract.test.js
- faultTests: tests/release-chain.test.js, tests/artifact-root.test.js
- securityTests: tests/signing.test.js, tests/release-chain.test.js
- loadTests: tests/release-integrity-load.test.js
- benchmarks: benchmarks/run.js (releaseIntegrity suite)
- limits: docs/LIMITS.md#release-integrity-provenance-and-reproducible-builds

_Gate F production claim: Git commit bounded to dist artifact root through release.json and release-manifest.json; tampering fails the chain closed._

### `release-provenance` — Signed release provenance and offline verification

- implementation: src/platform/signing.js, src/platform/release-chain.js, scripts/sign-release.js, scripts/verify-release-chain.js
- integrationTests: tests/signing.test.js, tests/release-chain.test.js
- faultTests: tests/signing.test.js, tests/release-chain.test.js
- securityTests: tests/signing.test.js, tests/release-chain.test.js
- loadTests: tests/release-integrity-load.test.js
- benchmarks: benchmarks/run.js (releaseIntegrity suite)
- limits: docs/LIMITS.md#release-integrity-provenance-and-reproducible-builds

_Gate F production claim: Ed25519 PEM key management, domain-bound signatures, key fingerprints, fail-closed verification._

### `reproducible-build` — Reproducible build evidence

- implementation: scripts/reproducible-build-evidence.js, scripts/build-dist.js, src/platform/artifact-root.js
- integrationTests: tests/release-integrity-load.test.js, tests/artifact-root.test.js
- faultTests: tests/release-integrity-load.test.js
- securityTests: tests/signing.test.js
- loadTests: tests/release-integrity-load.test.js
- benchmarks: benchmarks/run.js (releaseIntegrity suite)
- limits: docs/LIMITS.md#release-integrity-provenance-and-reproducible-builds

_Gate F production claim: two independent builds over the same committed source must produce the identical artifact root._

## EXPERIMENTAL (22)

### `postgres.source` — PostgreSQL source

Assurance: C1

- implementation: src/connectors/postgres/source.js
- integrationTests: tests/conformance/postgres-source-conformance.test.js, tests/postgres-materialization-contract.test.js
- faultTests: tests/conformance/postgres-command-recovery-conformance.test.js
- securityTests: tests/credential-broker.test.js, tests/platform-security.test.js
- loadTests: scripts/qualify-postgres-materialization.js
- benchmarks: scripts/qualify-postgres-materialization.js (MiB/s + RSS ceiling)
- limits: docs/LIMITS.md#postgresql

_Connector and local conformance fixtures exist, but live PostgreSQL source qualification has not been independently reproduced and SHA-bound for this bounded release; no production maturity claim._

### `postgres.target` — PostgreSQL target

Assurance: C4

- implementation: src/connectors/postgres/target.js, src/connectors/postgres/runtime.js, src/connectors/postgres/preflight.js
- integrationTests: tests/conformance/postgres-conformance.test.js, tests/conformance/postgres-command-source-conformance.test.js
- faultTests: tests/conformance/postgres-conformance.test.js, tests/conformance/postgres-command-recovery-conformance.test.js, tests/conformance/postgres-metadata-concurrency.test.js
- securityTests: tests/credential-broker.test.js, tests/platform-security.test.js
- loadTests: scripts/benchmarks/target-throughput.cjs
- benchmarks: qualification/postgres-target/results.json
- limits: docs/LIMITS.md#postgresql

_Write-throughput evidence pinned to commit 5b60af26b64390e454c116338694f6ca5220cc21 (2026-09-18): 100K rows at 110,375 rows/sec (9.54 MiB), 1M at 131,130, 5M at 118,296, no correctness errors. The 10M tier exceeds this host's disk headroom and is recorded as skipped; an earlier 10M attempt PANICed on WAL fdatasync (code 58030) when the host hit 0.3 GB free (see qualification/postgres-target/failure-10m.json, classified environmental, not a capability defect). Evidence not independently reproduced; EXPERIMENTAL until then._

### `postgres.content-exact` — PostgreSQL exact content verification

- implementation: src/connectors/postgres/content-verification.js, src/execution/content-verification.js, src/execution/content-verification-manifest.js
- integrationTests: tests/conformance/postgres-command-source-conformance.test.js, tests/conformance/postgres-content-verification.test.js
- faultTests: tests/conformance/postgres-content-verification.test.js, tests/conformance/postgres-repair-conformance.test.js
- securityTests: tests/credential-broker.test.js
- loadTests: scripts/benchmarks/content-verification.cjs
- benchmarks: benchmarks/run.js (contentVerification suite), qualification/postgres-content-verification/results.json
- limits: docs/LIMITS.md#postgresql

_Exact-content evidence pinned to commit 5b60af26b64390e454c116338694f6ca5220cc21 (2026-09-18) exercising the real target pipeline (commitBatch -> verifyContent -> createRepairPlan) over 1,000,000 rows: exact verification returned VERIFIED with diff 0; a tampered row produced DIFF/mismatch=1; a deleted row produced DIFF/missing=1; the resulting repair plan was hash-bound (UPDATE+INSERT). Observed verification throughput was ~3,032 rows/sec versus ~24,553 rows/sec for committing, i.e. verification is materially slower than write. Evidence not independently reproduced; EXPERIMENTAL until then._

### `postgres.repair` — PostgreSQL verified repair

- implementation: src/execution/repair-plan.js, src/execution/repair-runner.js, src/platform/repair-approval.js, src/execution/receipt.js
- integrationTests: tests/conformance/postgres-repair-conformance.test.js
- faultTests: tests/conformance/postgres-repair-conformance.test.js, tests/repair-refusal.test.js
- securityTests: tests/repair-approval.test.js
- benchmarks: benchmarks/run.js (repairPlan suite)
- limits: docs/LIMITS.md#repair-and-cutover

_Missing sustained repair-load evidence._

### `postgres.bulk` — PostgreSQL bulk COPY writes

- implementation: src/connectors/postgres/target.js
- integrationTests: tests/conformance/postgres-bulk-conformance.test.js
- faultTests: tests/conformance/postgres-bulk-conformance.test.js
- securityTests: tests/credential-broker.test.js
- limits: docs/LIMITS.md#postgresql

_Single-shot throughput printed in conformance, not a benchmark suite claim; no load test._

### `postgres.cdc` — PostgreSQL logical CDC capture

- implementation: src/connectors/postgres/cdc.js
- integrationTests: tests/conformance/postgres-cdc-conformance.test.js, tests/conformance/postgres-reference-recovery.test.js
- faultTests: tests/conformance/postgres-reference-recovery.test.js
- securityTests: tests/credential-broker.test.js
- loadTests: tests/conformance/postgres-reference-recovery.test.js
- limits: docs/LIMITS.md#postgresql

_Slot-lifecycle idempotency, ordered capture with LSN monotonicity, and checkpoint-resume are proven; large-scale soak and benchmark evidence in progress._

### `postgres.workers` — PostgreSQL distributed fenced workers

- implementation: src/connectors/postgres/workers.js
- integrationTests: tests/conformance/postgres-workers-conformance.test.js
- faultTests: tests/conformance/postgres-workers-conformance.test.js, tests/conformance/postgres-reference-recovery.test.js
- securityTests: tests/credential-broker.test.js
- limits: docs/LIMITS.md#postgresql

_Single-database source/target/CDC/worker patterns proven; industrial distributed execution (federated orchestration, cross-database transaction coordination, quorum decision) not yet implemented._

### `postgres.reference` — PostgreSQL reference workloads: soak, faults and recovery

- implementation: src/connectors/postgres/reference.js
- integrationTests: tests/conformance/postgres-reference-soak.test.js, tests/conformance/postgres-reference-recovery.test.js
- faultTests: tests/conformance/postgres-reference-soak.test.js, tests/conformance/postgres-reference-recovery.test.js
- securityTests: tests/credential-broker.test.js
- loadTests: tests/conformance/postgres-reference-soak.test.js, tests/conformance/postgres-reference-recovery.test.js
- limits: docs/LIMITS.md#postgresql

_Paced multi-writer soak, deadlock/serialization classification, backend termination and COPY cancellation, connection churn, slot-loss recovery, replay idempotency, lease steal, reconnect RTO and verify/repair are proven live against Docker PG 17.6; missing large-scale sustained soak and benchmark evidence for PRODUCTION._

### `postgres.schema-migration` — PostgreSQL schema migration protocol

- implementation: src/connectors/postgres/schema-migration.js
- integrationTests: tests/schema-migration.test.js, tests/conformance/postgres-schema-migration.test.js
- faultTests: tests/conformance/postgres-schema-migration.test.js
- securityTests: tests/credential-broker.test.js
- limits: docs/LIMITS.md#postgresql-schema-migration

_Structured diff, hashed ordered plans with safety classes, fenced atomic apply with drift refusal, approval-gated destructive steps and ledger receipts are proven live; missing default/index management, large-table online strategies and benchmark evidence for PRODUCTION._

### `postgres.mutations` — PostgreSQL keyed upsert, preconditioned delete and approved truncate

- implementation: src/connectors/postgres/target.js
- integrationTests: tests/conformance/postgres-mutations-conformance.test.js
- faultTests: tests/conformance/postgres-mutations-conformance.test.js
- securityTests: tests/credential-broker.test.js
- limits: docs/LIMITS.md#postgresql-mutations

_Upsert returns exact inserted/updated counts, delete enforces per-key row-hash preconditions atomically, truncate requires a bound approval and proves emptiness; missing bulk-scale mutation load and benchmark evidence for PRODUCTION._

### `postgres.database-source` — PostgreSQL whole-database source state

- implementation: src/connectors/postgres/database-source.js
- integrationTests: tests/conformance/postgres-database-source-conformance.test.js
- securityTests: tests/credential-broker.test.js
- limits: docs/LIMITS.md#postgresql

_Missing fault, load and benchmark evidence._

### `mysql.source` — MySQL source

Assurance: C1

- implementation: src/connectors/mysql/source.js
- integrationTests: tests/conformance/mysql-source-conformance.test.js
- securityTests: tests/mysql-connector.test.js, tests/credential-broker.test.js
- limits: docs/LIMITS.md#mysql

_Missing fault, load and benchmark evidence._

### `mysql.target` — MySQL target

Assurance: C4

- implementation: src/connectors/mysql/target.js, src/connectors/mysql/runtime.js, src/connectors/mysql/preflight.js
- integrationTests: tests/conformance/mysql-target-conformance.test.js
- faultTests: tests/conformance/mysql-target-conformance.test.js
- securityTests: tests/mysql-connector.test.js, tests/credential-broker.test.js
- limits: docs/LIMITS.md#mysql

_Missing load and benchmark evidence._

### `mssql.source` — SQL Server source

Assurance: C1

- implementation: src/connectors/mssql/source.js
- integrationTests: tests/conformance/mssql-source-conformance.test.js
- securityTests: tests/mssql-connector.test.js, tests/credential-broker.test.js
- limits: docs/LIMITS.md#sql-server

_Missing fault, load and benchmark evidence._

### `mssql.target` — SQL Server target

Assurance: C4

- implementation: src/connectors/mssql/target.js, src/connectors/mssql/runtime.js, src/connectors/mssql/preflight.js
- integrationTests: tests/conformance/mssql-target-conformance.test.js
- faultTests: tests/conformance/mssql-target-conformance.test.js
- securityTests: tests/mssql-connector.test.js, tests/credential-broker.test.js
- limits: docs/LIMITS.md#sql-server

_Missing load and benchmark evidence._

### `repair.protocol` — Verified repair protocol

- implementation: src/daemon/command-service.js, src/daemon/run-store.js
- integrationTests: tests/conformance/postgres-repair-conformance.test.js, tests/cutover.test.js
- faultTests: tests/conformance/postgres-repair-conformance.test.js, tests/repair-refusal.test.js
- securityTests: tests/repair-approval.test.js
- benchmarks: benchmarks/run.js (repairPlan suite)
- limits: docs/LIMITS.md#repair-and-cutover

_Missing sustained repair-load evidence._

### `cutover.protocol` — Cutover protocol

- implementation: src/daemon/command-service.js, src/daemon/run-store.js, src/protocol/svmp.js, src/protocol/svmp-model.js
- integrationTests: tests/cutover.test.js
- faultTests: tests/cutover.test.js
- securityTests: tests/cutover.test.js
- limits: docs/LIMITS.md#repair-and-cutover

_Missing load and benchmark evidence._

### `certified-connector-sdk` — Certified connector SDK

- implementation: scripts/generate-sdk.js
- integrationTests: tests/conformance/postgres-mutations-conformance.test.js
- faultTests: tests/conformance/postgres-mutations-conformance.test.js
- securityTests: tests/credential-broker.test.js
- limits: docs/LIMITS.md#postgresql

_Type-safe SDK generation from connector implementations; test bundles per-connector; missing full SDK lifecycle and publication evidence._

### `ai-safety` — AI-agent safety layer

- implementation: src/safety/safety-layer.js
- integrationTests: tests/safety-layer.test.js
- faultTests: tests/safety-layer.test.js
- securityTests: tests/safety-layer.test.js, tests/credential-broker.test.js
- limits: docs/LIMITS.md#postgresql

_Plan structure validation, depth/rate guards, undeclared-field and destructive-type refusal, dangerous SQL pattern filtering and privilege checks are covered by tests; the layer is not yet wired into a live agent surface and has no formal safety certification, so it stays EXPERIMENTAL._

### `public-scale-proof` — Public scale proof

- implementation: scripts/benchmarks/run.cjs
- integrationTests: tests/public-scale-proof.test.js
- faultTests: tests/public-scale-proof.test.js
- benchmarks: scripts/benchmarks/run.cjs (scale suite)
- limits: docs/LIMITS.md#postgresql

_Scale benchmark harness for slot lifecycle, CDC soak, connection churn and verify/repair convergence; the harness is covered for fail-closed configuration handling but no published cross-machine scale evidence exists, so it stays EXPERIMENTAL._

### `control-plane` — spoold control plane

- implementation: src/daemon/spoold.js
- integrationTests: tests/spoold.test.js
- faultTests: tests/spoold.test.js
- securityTests: tests/spoold.test.js, tests/platform-security.test.js
- limits: docs/LIMITS.md#control-plane-and-benchmarks

_Audit logging, session management, and policy enforcement proven; load and benchmark evidence in progress._

### `merkle-proofs` — Merkle proofs over content identities

- implementation: src/execution/merkle.js, src/execution/content-verification.js
- integrationTests: tests/content-verification.test.js
- benchmarks: benchmarks/run.js (merkle suite)
- limits: docs/LIMITS.md#control-plane-and-benchmarks

_Missing fault, security and load evidence._

## PLANNED (9)

### `oracle` — Oracle verification

- _no evidence claimed_

_Blocked: vendor sandbox access._

### `db2` — Db2 verification

- _no evidence claimed_

_Blocked: vendor sandbox access._

### `snowflake` — Snowflake verification

- _no evidence claimed_

_Blocked: vendor sandbox access._

### `bigquery` — BigQuery verification

- _no evidence claimed_

_Blocked: vendor sandbox access._

### `databricks` — Databricks verification

- _no evidence claimed_

_Blocked: vendor sandbox access._

### `redshift` — Redshift verification

- _no evidence claimed_

_Blocked: vendor sandbox access._

### `aurora-postgres` — Aurora PostgreSQL verification

- _no evidence claimed_

_Wire-compatible by design with the PostgreSQL connector; blocked: Aurora instance for proof._

### `aurora-mysql` — Aurora MySQL verification

- _no evidence claimed_

_Wire-compatible by design with the MySQL connector; blocked: Aurora instance for proof._

### `sap-hana` — SAP HANA verification

- _no evidence claimed_

_Blocked: vendor sandbox access._

## UNSUPPORTED (13)

### `filesystem.target` — Filesystem target

- _no evidence claimed_

_No filesystem target exists; writes go to database connectors only._

### `sqlite.source` — SQLite source

- _no evidence claimed_

_No SQLite source connector exists._

### `sqlite.content-exact` — SQLite read-after-write verification

- _no evidence claimed_

_The SQLite connector cannot prove exact read-after-write content._

### `sqlite.repair` — SQLite repair execution

- _no evidence claimed_

_Repair requires a verifying connector._

### `sqlite.bulk` — SQLite bulk writes

- _no evidence claimed_

_No bulk COPY path on SQLite._

### `mysql.content-exact` — MySQL read-after-write verification

- _no evidence claimed_

_The MySQL connector cannot prove exact read-after-write content._

### `mysql.repair` — MySQL repair execution

- _no evidence claimed_

_Repair requires a verifying connector._

### `mysql.bulk` — MySQL bulk writes

- _no evidence claimed_

_No bulk load path on MySQL._

### `mysql.cdc` — MySQL CDC capture

- _no evidence claimed_

_No binlog capture exists._

### `mssql.content-exact` — SQL Server read-after-write verification

- _no evidence claimed_

_The SQL Server connector cannot prove exact read-after-write content._

### `mssql.repair` — SQL Server repair execution

- _no evidence claimed_

_Repair requires a verifying connector._

### `mssql.bulk` — SQL Server bulk writes

- _no evidence claimed_

_No bulk load path on SQL Server._

### `mssql.cdc` — SQL Server CDC capture

- _no evidence claimed_

_No change-tracking capture exists._

> Generated from capabilities/matrix.json. Do not edit by hand.
