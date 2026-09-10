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

1. Durable content-bound customer-local source snapshots created incrementally while hashing.
2. Bounded-memory UTF-8 CSV parsing, dry-run and execution with a 256 MiB default Local Runner ceiling.
3. Bounded schema/violation sampling and target-batch accumulation instead of whole-dataset source/output arrays.
4. Cross-platform-safe snapshot filenames with semantic identity independent of the snapshot path.
5. Approved-source revalidation before target mutation; changed/replaced/missing input fails `SOURCE_CHANGED`.
6. Deterministic plan, batch and checkpoint identities.
7. Live SQLite destination preflight with target contract fingerprinting.
8. Approval bound to the plan, source snapshot, live target contract, effects, principal and expiry.
9. Durable per-batch target ledger committed atomically with migrated rows.
10. Exact `reconcileTargetCommit(batchIdentity)` semantics.
11. Commit-before-checkpoint crash recovery without duplicate replay.
12. Durable checkpoint restart by re-scanning the immutable snapshot and skipping proven source ranges.
13. Idempotent exact replay and hard conflict on changed evidence.
14. Durable leases plus monotonic fencing tokens checked inside target transactions.
15. Filesystem allow-root enforcement with traversal and symlink/junction containment.
16. Exact row-accounting and ledger-completeness verification.
17. Canonical commit-bound migration receipts.
18. Snapshot cleanup only after VERIFIED terminal truth; interrupted runs retain recovery material.
19. Shared production command service used by CLI/`spoold` transports.
20. Loopback-only authenticated `spoold` transport with Host/Origin and request-boundary checks.
21. Dedicated SQLite conformance/fault suite and Linux/Windows/macOS native-driver matrix.
22. Streaming malformed-input, source-ceiling, source-change, target-lock and crash/restart fault coverage.
23. Constrained-old-space large-source proof above the Browser Studio 50 MiB boundary.
24. Canonical customer-style CRM migration fixture using the real command-service path.

Gate B explicitly rejects virtual/triggered SQLite targets, unsupported destructive/write strategies, unlimited source size and hosted raw-row ingestion.

## Next — broaden only after the same contract is proven

### PostgreSQL adapter

PostgreSQL is the next destination, but it must implement the same safety semantics rather than becoming a thin connector wrapper:

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

- Browser OPFS/streaming only after quota/recovery behavior is measured.
- Larger-than-256-MiB Local Runner ceilings only after explicit disk, runtime and soak evidence supports a new boundary.
- Long-duration load and soak tests with explicit resource ceilings.

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
