# SPOOL Roadmap

SPOOL orders work by **migration correctness, recoverability and evidence**, not connector count.

## Delivered in Gate A — browser migration correctness

- Local-first browser CSV Studio with `connect-src 'none'`.
- Deterministic transformation IR; no arbitrary generated code.
- Deterministic locale-number/date parsing with ambiguous values rejected.
- Typed target validation and grouped bounded violations.
- Worker job/revision/sequence isolation.
- IndexedDB durability, checkpoint recovery and storage-write failure handling.
- Revision-aware replay.
- Spreadsheet-formula-safe export.
- Explicit 50 MiB browser input boundary.
- Built-artifact Chrome release smoke with deep-link and IndexedDB-reload validation.

## Delivered in Gate B — production CSV → SQLite execution

The production claim is intentionally limited to filesystem UTF-8 CSV → existing ordinary SQLite table using insert mode.

Implemented safety contract:

1. Content-bound source snapshots using the same opened source bytes that are migrated.
2. Deterministic plan, batch and checkpoint identities.
3. Live SQLite destination preflight with target contract fingerprinting.
4. Approval bound to the plan, source snapshot, live target contract, effects, principal and expiry.
5. Durable per-batch target ledger committed atomically with migrated rows.
6. Exact `reconcileTargetCommit(batchIdentity)` semantics.
7. Commit-before-checkpoint crash recovery without duplicate replay.
8. Idempotent exact replay and hard conflict on changed evidence.
9. Durable leases plus monotonic fencing tokens checked inside target transactions.
10. Filesystem allow-root enforcement with traversal and symlink/junction containment.
11. Exact row-accounting and ledger-completeness verification.
12. Canonical commit-bound migration receipts.
13. Shared production command service used by CLI/`spoold` transports.
14. Loopback-only authenticated `spoold` transport with Host/Origin and request-boundary checks.
15. Dedicated SQLite conformance/fault suite and Linux/Windows/macOS native-driver matrix.
16. Canonical customer-style CRM migration fixture using the real command-service path.

Gate B explicitly rejects virtual/triggered SQLite targets and unsupported destructive/write strategies.

## Next — broaden only after the same contract is proven

### PostgreSQL adapter

PostgreSQL is the next likely destination, but it must implement the same safety semantics rather than becoming a thin connector wrapper:

- source/target identity and snapshot semantics;
- transactional batch evidence;
- exact post-crash reconciliation;
- idempotent replay;
- lease/fencing behavior appropriate to a networked target;
- credential isolation;
- target-schema/contract drift checks;
- deadlock/serialization/network/restart fault tests;
- verification and receipts.

SPOOL will not label PostgreSQL production-ready until its connector conformance suite is green.

### Scale

- Streaming local-runner ingestion so memory is bounded by batch size rather than dataset size.
- Browser OPFS/streaming only after quota/recovery behavior is measured.
- Large-data load and soak tests with explicit resource ceilings.

### Enterprise/control plane

Only after real connector usage justifies it:

- optional metadata-only managed control plane;
- organization/RBAC/SSO;
- fleet/job visibility;
- policy distribution;
- audit retention;
- managed support/SLA operations;
- usage metering.

Raw rows should remain outside the hosted control plane by default.

## Explicit non-goals

SPOOL will not:

- claim a connector is production-ready because it connects once;
- silently coerce ambiguous migration values;
- execute arbitrary model-generated code against migration data;
- hide unsupported/destructive operations behind a generic Run button;
- fabricate benchmark, test or deployment evidence;
- weaken crash/reconciliation guarantees to increase connector count.

## Release rule

A capability moves from roadmap to production only when its checked-in implementation, adversarial tests, release gate, security scan and deployment evidence prove the claim.
