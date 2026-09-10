# SPOOL

**Migration correctness infrastructure: dirty data in, typed and verified data out.**

SPOOL is an open-source local-first migration product built and commercially supported by **Dharan Tej Reddy Poduvu**, an individual solo builder. There is currently no incorporated SPOOL company and no paid SaaS dependency required to use or buy supported migration services.

SPOOL has two deliberately separate local-first execution paths:

1. **Browser Studio** — profile, infer, deterministically transform, validate and export CSV data without sending rows to an application backend.
2. **Gate B Local Runner** — bounded-memory streaming execution of an approved UTF-8 filesystem CSV into an existing ordinary SQLite table with a durable content-bound source snapshot, live target preflight, transactional batch evidence, crash reconciliation, fencing, verification and a commit-bound receipt. The Local Runner defaults to a **256 MiB** source ceiling while Browser Studio remains capped at **50 MiB**.

[Technical browser surface](https://spool-webmcp.vercel.app/) · [Request a Migration Assessment](https://github.com/dharan1007/spool/issues/new?template=migration-assessment.yml) · [Local Runner](docs/LOCAL_RUNNER.md) · [Customer engagement workflow](docs/CUSTOMER_ENGAGEMENT.md) · [Migration services](docs/MIGRATION_SERVICES.md) · [Security](SECURITY.md)

> The Vercel endpoint is a technical/open-source Browser Studio and documentation surface, not a paid customer data plane or checkout. Paid target work is delivered locally/customer-side so no paid hosting is required before revenue.

[![release-gate](https://github.com/dharan1007/spool/actions/workflows/ci.yml/badge.svg)](https://github.com/dharan1007/spool/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Install the Local Runner

Node.js 22+ is required. The release remains protected against accidental npm-registry publication; installation is directly from the signed/versioned GitHub source or release artifact.

For the current published release:

```bash
npm install -g github:dharan1007/spool#v1.0.0
spool --help
```

Source-verification path:

```bash
git clone --branch v1.0.0 https://github.com/dharan1007/spool.git
cd spool
npm ci
npm run check
npm run pack:verify
```

The GitHub Release also carries the packed `.tgz` plus SHA-256 release evidence so it can be installed locally without publishing SPOOL to the npm registry.

## What SPOOL is production-claiming

### Browser Studio

```text
messy CSV
  → PROFILE
  → INFER
  → deterministic PLAN
  → representative DRY RUN
  → EXECUTE in Worker
  → VERIFY
  → typed output + violations + lineage
```

The browser path is local-first and retains the production CSP boundary `connect-src 'none'`. The current browser input limit is **50 MiB**. SPOOL fails closed on ambiguous dates/numbers, invalid target values, storage-capacity failure and unsafe export cells.

### Gate B Local Runner

The production connector scope is intentionally narrow and evidence-backed. The Local Runner uses bounded-memory streaming and defaults to a **256 MiB** source ceiling; the ceiling is a deliberate product boundary, not a claim that a 256 MiB dataset is retained in JavaScript memory.

```text
UTF-8 filesystem CSV
  → durable content-bound local source snapshot
  → streamed profile / deterministic plan / streamed dry run
  → live SQLite target preflight
  → bound approval
  → revalidate original source against approved snapshot
  → durable lease + fencing token
  → stream immutable snapshot in bounded batches
       migrated rows
       + SPOOL reconciliation ledger
       commit atomically
  → re-scan immutable snapshot from a durable checkpoint on restart
  → exact row/ledger verification
  → hashed migration receipt bound to release commit
  → verified snapshot cleanup
```

Supported Gate B target and execution boundaries:

- an **existing ordinary SQLite table**;
- `insert` write strategy only;
- batches of 1–10,000 source rows;
- default Local Runner source ceiling of **256 MiB**;
- bounded-memory CSV parsing/transformation rather than a whole-dataset JS array;
- destination schema/affinity/nullability checked before approval;
- table DDL, columns, indexes and foreign keys fingerprinted as a `targetContractId`;
- targets with triggers or virtual-table behavior rejected;
- target contract rechecked inside every write transaction;
- source and target paths constrained to configured allow-roots;
- every SQLite write requires `target_write` approval bound to the exact plan, source snapshot, target contract, effects, principal and expiry.

## Durable snapshot and bounded-memory lifecycle

The Local Runner copies the source to a **customer-local durable snapshot** while hashing it. The semantic snapshot identity continues to bind the original canonical source path, byte length and SHA-256 content digest. Snapshot filenames are filesystem-safe across Linux, macOS and Windows; their paths are intentionally non-semantic and are never part of approval or receipt identity.

`inspect`, `dry-run`, `approve` and `run` read CSV records incrementally. Schema inference retains only a bounded sample and transform validation keeps bounded violation samples. Execution retains only the current target batch plus bounded evidence, not a second in-memory copy of the source dataset. CI includes a real Local Runner migration of a source larger than the Browser Studio 50 MiB boundary while V8 old-space is explicitly constrained to 48 MiB.

The durable snapshot is what makes deterministic restart possible. After a crash or restart, SPOOL loads the exact approved snapshot, re-scans it from the beginning, discards records before the durable checkpoint, reconciles target evidence before replay, and continues at the next whole batch. This trades sequential disk reads for deterministic bounded memory and exact replay semantics.

Before target mutation, the original source is revalidated against the approved snapshot. A changed, replaced or missing approved source fails as `SOURCE_CHANGED` before a target write lease is acquired. After VERIFIED completion and a durable receipt, SPOOL cleans the per-migration snapshot directory. Interrupted or failed runs keep their snapshot so a later retry can prove and resume the same approved bytes.

Plan disk space accordingly: snapshot creation temporarily requires roughly one additional source-file-sized allocation, and the SQLite target needs its own growth/WAL/headroom. The 256 MiB default ceiling is therefore not a promise that any machine with 256 MiB free RAM can run the migration, and it is not a 1-GB/unlimited-file claim.

## What SPOOL does **not** claim yet

The current production claim does not include PostgreSQL/MySQL execution, remote hosted database credentials, `upsert`/`replace`/`delete`/`truncate`, virtual SQLite tables, SQLite targets with triggers, server-side raw-row ingestion, unlimited browser file size, unlimited Local Runner source size, or legal/regulatory certification.

Unsupported behavior fails closed instead of being marketed as production-ready.

## Crash and replay guarantees

Each logical target batch receives a deterministic identity bound to migration ID, plan ID, source snapshot ID, mapping revision, source range and target identity.

For SQLite, migrated rows and the batch reconciliation ledger are written in the same transaction. If the process stops after target commit but before SPOOL persists its local checkpoint, restart calls `reconcileTargetCommit(batchIdentity)`. Exact committed evidence advances the checkpoint without replaying rows; conflicting or indeterminate evidence stops the migration.

Durable leases issue monotonic fencing tokens. The SQLite writer checks the fencing token **inside the target transaction**, so a stale runner cannot write after another runner takes over.

## Verification and receipts

A run cannot produce a receipt until verification passes. Verification proves:

```text
source rows = written rows + explicitly rejected rows + explicitly filtered rows
```

and checks every expected batch has exact reconciliation-ledger evidence.

The final receipt includes migration/plan/source/target identities, target-contract ID, batch identities, counts, violation summary, verification result, timestamps, SPOOL version and exact Git commit SHA. The canonical receipt is SHA-256 hashed.

## Real customer-style fixture

`examples/crm-export/` uses the same production `SpoolCommandService` path as the Local Runner and includes dirty currency/locale values, canonical/textual dates, an intentionally ambiguous numeric date, mixed booleans, an invalid numeric ID, target DDL and a production migration request.

`tests/crm-example.test.js` verifies exact target rows, violations, reconciliation ledger and final receipt. `npm run pack:verify` additionally packs SPOOL, installs the resulting artifact into a clean temporary prefix, and runs that same CRM path through the installed `spool` executable.

## Local Runner surfaces

The production transports dispatch into the same command service rather than a second migration engine:

- `SpoolCommandService` — production command boundary;
- installed `spool` CLI staged commands;
- `spoold` — loopback-only authenticated HTTP bridge with Host/Origin checks and bounded requests;
- durable local run/checkpoint store;
- SQLite target, lease and reconciliation stores.

For the complete command lifecycle and `migration.json`, see [`docs/LOCAL_RUNNER.md`](docs/LOCAL_RUNNER.md).

## Deterministic safety properties

Current safety coverage includes bounded-memory streaming CSV parsing, deterministic locale-number/date/local-datetime parsing, ambiguous numeric-date rejection, typed target validation, durable source snapshot binding and cleanup, source revalidation, target-contract drift rejection, exact replay/idempotency, commit-before-checkpoint recovery, checkpoint re-scan, stale-fence rejection, credential-reference isolation, filesystem traversal/symlink containment, spreadsheet-formula neutralization, browser IndexedDB quota/write failure handling and Worker job/revision/sequence isolation.

## Release evidence

The release gate runs:

```text
npm ci
npm audit --omit=dev --audit-level=high
stable SQLite native-driver load check
full tests
Gate B SQLite conformance/fault suite
streaming parser boundary/fault tests
>50 MiB constrained-old-space Local Runner proof
build
benchmark
static security/release checks
packed/global-installed CLI CRM smoke
real built-artifact Chrome smoke
```

SQLite conformance and installed-package verification run on GitHub-hosted Linux, Windows and macOS runners. CodeQL runs independently.

Every production build can emit `release.json` containing the exact source commit through `SPOOL_COMMIT_SHA`. GitHub releases additionally publish an artifact checksum manifest and release record.

## Commercial work with zero infrastructure spend

You do **not** need a company, paid hosting, hosted database, auth system, analytics product, or payment gateway to sell the current supported services.

Current launch-price hypotheses:

- **Migration Preflight** — ₹2,500–₹7,500;
- **Import-Ready Dataset** — ₹5,000–₹15,000;
- **Migration Rescue** — ₹7,500–₹25,000+;
- **Verified CSV → SQLite Migration** — ₹10,000–₹30,000+.

These are quoted after qualification, not guaranteed fixed tariffs. Paid work is the scoped service outcome, execution and support—not paid access to the MIT-licensed source.

The zero-cost customer flow is:

```text
metadata-only assessment
→ private qualification + quote
→ written target authorization + backup responsibility
→ customer-local SPOOL execution
→ verification/receipt + delivery manifest
→ written acceptance
→ optional case-study consent
```

Operational documents:

- [`docs/CUSTOMER_ENGAGEMENT.md`](docs/CUSTOMER_ENGAGEMENT.md)
- [`docs/AUTHORIZATION_TEMPLATE.md`](docs/AUTHORIZATION_TEMPLATE.md)
- [`docs/DELIVERY_ACCEPTANCE_TEMPLATE.md`](docs/DELIVERY_ACCEPTANCE_TEMPLATE.md)
- [`docs/CASE_STUDY_CONSENT_TEMPLATE.md`](docs/CASE_STUDY_CONSENT_TEMPLATE.md)
- [`docs/INVOICE_QUOTE_TEMPLATE.md`](docs/INVOICE_QUOTE_TEMPLATE.md)
- [`docs/MIGRATION_SERVICES.md`](docs/MIGRATION_SERVICES.md)
- [`docs/DATA_HANDLING.md`](docs/DATA_HANDLING.md)
- [`docs/COMMERCIAL_SUPPORT.md`](docs/COMMERCIAL_SUPPORT.md)
- [`docs/TERMS_TEMPLATE.md`](docs/TERMS_TEMPLATE.md)
- [`docs/PRIVACY_TEMPLATE.md`](docs/PRIVACY_TEMPLATE.md)

Public intake is metadata only. Never post production rows, customer/employee data, credentials, database dumps, private URLs, payment details, or identity documents to a GitHub issue.

## Roadmap

The next connector is not added merely because it can connect once. PostgreSQL or any other destination must satisfy the same snapshot/idempotency/reconciliation/fencing/verification contract before SPOOL calls it production-ready. See [`ROADMAP.md`](ROADMAP.md).
