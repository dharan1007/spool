# SPOOL

**Migration correctness infrastructure: dirty data in, typed and verified data out.**

SPOOL has two deliberately separate local-first execution paths:

1. **Browser Studio** — profile, infer, deterministically transform, validate and export CSV data without sending rows to an application backend.
2. **Gate B local runner** — execute an approved UTF-8 filesystem CSV migration into an existing ordinary SQLite table with source snapshot binding, live target preflight, transactional batch evidence, crash reconciliation, fencing, verification and a commit-bound receipt.

[Try the browser Studio](https://spool-webmcp.vercel.app/) · [Request a Migration Assessment](https://github.com/dharan1007/spool/issues/new?template=migration-assessment.yml) · [Architecture](docs/ARCHITECTURE.md) · [Data handling](docs/DATA_HANDLING.md) · [Commercial support](docs/COMMERCIAL_SUPPORT.md) · [Migration services](docs/MIGRATION_SERVICES.md)

[![release-gate](https://github.com/dharan1007/spool/actions/workflows/ci.yml/badge.svg)](https://github.com/dharan1007/spool/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What SPOOL is production-claiming

### Browser Studio

```text
messy CSV
  → PROFILE
  → INFER
  → deterministic PLAN
  → DRY RUN
  → EXECUTE in Worker
  → VERIFY
  → typed output + violations + lineage
```

The browser path is local-first and retains the production CSP boundary `connect-src 'none'`. The current browser input limit is **50 MiB**. SPOOL fails closed on ambiguous dates/numbers, invalid target values, storage-capacity failure and unsafe export cells.

### Gate B local runner

The production connector scope is intentionally narrow and evidence-backed:

```text
UTF-8 filesystem CSV
  → content-bound source snapshot
  → deterministic plan + dry run
  → live SQLite target preflight
  → bound approval
  → durable lease + fencing token
  → batch transaction
       migrated rows
       + SPOOL reconciliation ledger
       commit atomically
  → reconcile on restart
  → exact row/ledger verification
  → hashed migration receipt bound to release commit
```

Supported Gate B target:

- an **existing ordinary SQLite table**;
- `insert` write strategy only;
- batches of 1–10,000 rows;
- destination schema/affinity/nullability checked before approval;
- target table DDL, columns, indexes and foreign keys fingerprinted as a `targetContractId`;
- targets with triggers or virtual-table behavior are rejected;
- the target contract is rechecked inside each write transaction;
- source and target paths must remain within configured filesystem allow-roots;
- every production SQLite write requires `target_write` approval bound to the exact plan, source snapshot, target contract, effects, principal and expiry.

## What SPOOL does **not** claim yet

The current production claim does not include:

- PostgreSQL or MySQL execution;
- remote hosted database credentials;
- `upsert`, `replace`, `delete` or `truncate` strategies;
- virtual SQLite tables;
- SQLite targets with triggers;
- server-side raw-row ingestion;
- unlimited browser file size;
- automatic legal/regulatory certification.

Those boundaries are intentional. Unsupported behavior fails closed rather than being described as production-ready.

## Crash and replay guarantees

Each logical target batch receives a deterministic identity bound to:

- migration ID;
- plan ID;
- source snapshot ID;
- mapping revision;
- source range;
- target identity.

For SQLite, migrated rows and the batch reconciliation ledger are written in the same transaction. If the process stops after target commit but before SPOOL persists its local checkpoint, restart calls `reconcileTargetCommit(batchIdentity)`. Exact committed evidence advances the checkpoint without replaying rows; conflicting or indeterminate evidence stops the migration.

Durable leases issue monotonic fencing tokens. The SQLite writer checks the fencing token **inside the target transaction**, so a stale runner cannot write after another runner takes over.

## Verification and receipts

A run cannot produce a receipt until verification passes. Verification proves:

```text
source rows = written rows + explicitly rejected rows + explicitly filtered rows
```

and checks that every expected batch has exact reconciliation-ledger evidence.

The final receipt includes the migration/plan/source/target contract identities, batch identities, counts, violation summary, verification result, timestamps, SPOOL version and exact Git commit SHA. The canonical receipt record is SHA-256 hashed.

## Real customer-style fixture

`examples/crm-export/` is a checked-in migration case using the same production `SpoolCommandService` path as the local runner. It contains:

- dirty currency/locale values;
- canonical and textual dates;
- an intentionally ambiguous numeric date that must be rejected;
- mixed boolean representations;
- an invalid numeric ID;
- an existing SQLite target DDL;
- a production migration request.

`tests/crm-example.test.js` verifies the exact target rows, violations, reconciliation ledger and final receipt.

## Local runner surfaces

The browser UI, CLI/daemon work and production SQLite execution are separated by trust boundary, but the production transports dispatch into the same command service rather than implementing a second migration engine.

The local transport stack includes:

- `SpoolCommandService` — the production command boundary;
- CLI staged commands;
- `spoold` — loopback-only authenticated HTTP bridge with Host/Origin checks and bounded requests;
- durable local run/checkpoint store;
- SQLite target, lease and reconciliation stores.

## Deterministic safety properties

SPOOL does not execute arbitrary model-generated JavaScript against migration data. Transform expressions use a constrained IR with bounded recursion and regex rules. Current safety coverage includes:

- deterministic locale-number parsing;
- deterministic date parsing with ambiguous numeric dates rejected;
- typed target validation;
- source snapshot binding;
- target-contract drift rejection;
- exact batch replay/idempotency;
- commit-before-checkpoint recovery;
- stale-fence rejection;
- credential-reference redaction/isolation primitives;
- filesystem traversal and symlink/junction containment;
- spreadsheet-formula neutralization;
- browser IndexedDB quota/write failure handling;
- Worker job/revision/sequence isolation.

## Release evidence

The release gate runs:

```text
npm ci
npm audit --omit=dev --audit-level=high
stable SQLite native-driver load check
full tests
Gate B SQLite conformance/fault suite
build
benchmark
static security/release checks
real built-artifact Chrome smoke
```

SQLite conformance is also executed on GitHub-hosted Linux, Windows and macOS runners. CodeQL runs independently.

The browser smoke opens the built `dist/`, executes the 25,000-row Autopilot workflow, reaches COMPLETE/results, reloads through SPA deep links, proves IndexedDB restoration and rejects runtime/network-console failures.

Every production build writes `release.json` containing the exact source commit when `SPOOL_COMMIT_SHA` is supplied. Production rollout is accepted only when the deployed release SHA matches the intended Git commit.

## Run locally

Node.js 22+ is required. Gate B uses the pinned `better-sqlite3` native driver from the committed npm lockfile.

```bash
git clone https://github.com/dharan1007/spool.git
cd spool
npm ci
npm run check
npm run serve
```

Useful verification commands:

```bash
npm test
npm run test:conformance
npm run build
npm run benchmark
node scripts/static-check.js
npm run check
```

## Commercial use and support

The open-source repository remains MIT licensed. Commercial value is offered around real migration outcomes rather than a cosmetic premium tier:

- Migration Preflight;
- Import-Ready Dataset;
- Migration Rescue;
- Verified CSV → SQLite Migration;
- scoped connector/integration work after the relevant safety contract exists.

Public intake is **metadata only**. Never post production rows, customer/employee data, credentials, database dumps or private URLs to a GitHub issue. A production migration requires a private channel, written scope, backup/restore responsibility and explicit authorization before target mutation.

See:

- [`docs/DATA_HANDLING.md`](docs/DATA_HANDLING.md)
- [`docs/COMMERCIAL_SUPPORT.md`](docs/COMMERCIAL_SUPPORT.md)
- [`docs/MIGRATION_SERVICES.md`](docs/MIGRATION_SERVICES.md)
- [`docs/TERMS_TEMPLATE.md`](docs/TERMS_TEMPLATE.md) — counsel-review template
- [`docs/PRIVACY_TEMPLATE.md`](docs/PRIVACY_TEMPLATE.md) — counsel-review template
- [`SECURITY.md`](SECURITY.md)

## Roadmap

The next connector is not added merely because it can connect once. PostgreSQL or any other destination must satisfy the same snapshot/idempotency/reconciliation/fencing/verification contract before SPOOL calls it production-ready. See [`ROADMAP.md`](ROADMAP.md).
