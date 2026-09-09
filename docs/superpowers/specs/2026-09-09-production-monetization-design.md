# SPOOL Production and Monetization Design

## Status

Approved for implementation on 2026-09-09. This document codifies the previously reviewed architecture and defines the gates that must be satisfied before SPOOL may make stronger production claims.

## Goal

Make SPOOL commercially operable for its proven local-first CSV scope, then extend the same deterministic safety model to real destination execution without introducing a second business-logic path or weakening SPOOL's privacy boundary.

## Non-negotiable product truths

1. The secure Studio remains local-first and does not transmit customer rows by default.
2. No arbitrary model-generated code may execute against migration data.
3. Ambiguous or destructive transformations fail closed.
4. Human UI, CLI, daemon and agent/MCP surfaces share one command/service boundary.
5. A connector is not called production-ready until conformance and fault-injection tests prove its advertised capabilities.
6. A migration is not complete when writes return successfully; it is complete only after canonical verification and a receipt.
7. Production claims must match checked-in evidence. Unsupported scale, connector or reliability claims are prohibited.

## Product surfaces

### Secure browser Studio

The existing browser Studio continues to own file profiling, deterministic plan generation, dry-run, local execution, violation review and export for the bounded CSV use case. Its strict CSP and no-network data plane remain intact. Commercial tracking, payment widgets and CRM scripts must not be added to the secure Studio origin.

### Commercial/marketing surface

Lead capture, commercial documentation, service descriptions, terms and privacy content may live on a separate origin/site so the Studio can retain `connect-src 'none'` and `form-action 'none'`.

### Local runner (`spoold`)

Real source/target connector execution runs in a local process, not in the browser. `spoold` owns credentials, leases/fencing, source snapshots, batch execution, target reconciliation, verification and receipts. The browser/CLI/MCP surfaces call the same command service exposed by this runner.

## Release architecture

Every production release must bind a Git commit to the deployed artifact:

`main SHA -> release gate -> browser E2E -> build -> release manifest -> deploy -> post-deploy smoke -> accepted production release`

The static build emits `release.json` containing version, commit, build timestamp and deterministic build metadata supplied by CI. The release workflow fails if browser smoke or release-contract checks fail.

## CSV commercial-readiness gate

Before the first paid CSV/preflight/rescue engagement:

- commercial hosting terms are appropriate for paid operation;
- current canonical main is deployed;
- CI contains browser smoke, not only unit/static tests;
- a production post-deploy smoke checks the public Studio;
- release provenance is visible via `release.json`;
- the migration regression corpus covers locale numbers, dates, booleans, headers, malformed CSV and formula-injection cases;
- one canonical real-world end-to-end fixture uses the same production engine;
- storage/quota failures are explicit and cannot produce false COMPLETE states;
- the current 50 MB browser boundary is visible and enforced before execution;
- stable customer-safe error codes exist;
- support, privacy, terms and data-handling documentation exist;
- paid work uses a private commercial support path and a scoped SOW/invoice process.

## Connector contract

Source connectors must support identity, immutable/snapshot-bound reads and deterministic cursors. Target connectors must support preparation, exact batch commit semantics, reconciliation, verification and explicit capability reporting.

A target connector may advertise `reconcileAfterCrash`, `atomicBatchLedger`, `idempotentReplay`, `snapshotBinding` or `fencing` only when its conformance suite proves the behavior.

## Source snapshot binding

Every resumable run binds checkpoints to a source snapshot. A file snapshot includes stable identity properties and content fingerprinting. Database sources use an appropriate database snapshot/version position. Resume against a different snapshot fails with `SOURCE_CHANGED`; SPOOL never silently continues against changed input.

## Batch identity

A batch identity is deterministic over migration identity, plan identity, source snapshot identity, mapping revision, source range and target identity. Replaying the same logical batch derives the same identity. The same identity with different payload evidence is a hard conflict.

## SQLite safety model

SQLite is the first production connector. Every migrated batch and its SPOOL ledger row commit in the same SQLite transaction. The ledger records batch identity, migration/plan/snapshot identity, mapping revision, row count and payload hash.

After a crash, `reconcileTargetCommit(batchIdentity)` returns only:

- `COMMITTED_EXACT`
- `NOT_COMMITTED`
- `CONFLICT`
- `INDETERMINATE`

Only `COMMITTED_EXACT` permits advancing a stale local checkpoint without replaying writes. Conflict/indeterminate states fail closed.

The conformance suite must kill execution after target commit but before local checkpoint persistence and prove restart without duplicate writes.

## Leases and fencing

Long-running target mutation uses an execution lease plus monotonically increasing fencing token. A stale runner cannot continue writes after a newer lease holder is established. Process-local PID locks alone are insufficient.

## Approval binding

Destructive approval binds at minimum to migration ID, plan ID/revision, source snapshot, target identity, approved effects/write strategy, principal, expiry and nonce. Any bound semantic change invalidates the approval.

## Credential isolation

Connector references store only typed secret references. Resolved credentials exist only in the local execution boundary and are never serialized into plans, checkpoints, receipts, browser state, logs, agent results or telemetry.

## Filesystem containment

File/SQLite paths are resolved through an allowlisted root policy and rejected when canonical/real paths escape the permitted root through traversal, symlinks or junctions. Filesystem connectors do not accept arbitrary unrestricted paths in production mode.

## Verification

Successful target writes transition to verification, not directly to completion. Verification proves row accounting, schema/constraint expectations, ledger completeness and configured invariants. The core accounting invariant is:

`source rows = written rows + explicitly rejected rows + explicitly filtered rows`

with zero unexplained rows.

## Receipt

A final canonical receipt contains software/release identity, migration/plan/snapshot/target identity, batch identities, counts, violations summary, verification results and timestamps. The canonical receipt is hashed; signing can be layered later without changing the semantic receipt.

## CLI and agent interfaces

CLI and MCP/agent tools expose staged operations: inspect, plan, dry-run, review risk, approve/request approval, execute approved plan, verify, receipt. They do not bypass the command service, policy evaluation or connector conformance constraints.

## Observability

The secure Studio remains row-telemetry-free. `spoold` emits structured metadata-only operational events keyed by migration/run/plan/batch IDs. Logs must redact credentials and unbounded row content.

## Production claim gates

### Gate A — paid CSV/local-first

Commercial hosting + legal/support layer + release provenance + browser release gate + correctness corpus + explicit product limits.

### Gate B — production SQLite

Gate A plus connector contract, snapshot binding, deterministic batch identity, atomic ledger, exact crash reconciliation, replay conflict detection, fencing, bound approvals, credential isolation, filesystem containment, verification, receipt, `spoold`, CLI and conformance/fault tests.

### Gate C — production PostgreSQL

Gate B plus PostgreSQL connector and network/transaction/deadlock/restart/schema-drift/load fault suite.

### Gate D — enterprise control plane

Only after proven connector execution: organization/RBAC/SSO, fleet visibility, centralized policy, managed metadata, support SLAs, billing/metering and enterprise agreements. Raw customer rows remain local by default.

## Explicit non-goals for this rollout

- no generic AI chatbot;
- no seat-based premium gating as the primary monetization mechanism;
- no dozens of shallow connectors before SQLite conformance;
- no weakening the Studio CSP for analytics or billing;
- no claim of unlimited browser-scale data;
- no claim of production database migration before Gate B/C evidence exists.
