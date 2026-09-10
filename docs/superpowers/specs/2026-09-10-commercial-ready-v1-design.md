# SPOOL Commercial-Ready v1 Design

## Purpose

Ship SPOOL as a zero-cash, commercially usable, local-first migration product under Dharan Tej Reddy Poduvu's own name. The release must let a stranger discover the product, install it, run a supported migration, understand the safety boundary, and complete a paid local/customer-side engagement without requiring a company, paid SaaS backend, hosted raw-row processing, or a payment gateway.

## Non-negotiable constraints

- Infrastructure spend for this release: ₹0.
- Do not weaken Browser Studio's `connect-src 'none'` privacy boundary.
- Do not claim hosted SQLite execution; Gate B remains customer-local.
- Do not claim legal, tax, privacy, security, or regulatory certification.
- Do not publish personal banking, PAN/Aadhaar, home address, customer data, secrets, database dumps, or private URLs.
- `main` remains protected and releases are exact-SHA/provenance bound.
- Existing production scope remains UTF-8 filesystem CSV → existing ordinary SQLite table, `insert` only.
- Every production capability must have tests and release evidence before it is presented as supported.

## Release Train 1: commercial launch core

### 1. Installable local runner

SPOOL must expose a real `spool` executable through `package.json` `bin`, with the existing CLI as the sole command implementation. The supported zero-cost install paths are:

1. `npm install -g github:dharan1007/spool#v1.0.0` after the Git tag exists.
2. Download the GitHub Release source/package artifact and run `npm install -g <artifact>`.
3. Clone the repository and run the existing Node entry point for source-based verification.

No npm registry publication is required for v1.0.0. The package remains protected against accidental registry publication unless a future explicitly approved npm publishing plan exists.

The release gate must prove that a clean packed/installable artifact exposes `spool --help`, loads `better-sqlite3`, and can execute the canonical CRM fixture through the installed binary rather than a repository-relative `node src/cli/spool.js` invocation.

### 2. GitHub v1.0.0 release

Create a `v1.0.0` tag/release pointing to the exact protected-main SHA that passes the release gate. Release assets must include an npm-pack-compatible `.tgz`, SHA-256 checksum manifest, release metadata, and a concise supported-scope statement. The release must link to installation, local-runner, security, data-handling, and migration-service documentation.

A durable release workflow belongs on `main`; the actual first release may be triggered with an ops-only workflow if connector limitations prevent direct tag/release creation. The workflow must fail closed if the requested SHA does not equal protected `main` or if tests/build/package verification fail.

### 3. Commercial operating workflow

The repository and website must provide a professional, zero-cost operating path:

`lead → metadata-only assessment → private qualification → written quote/scope → payment terms → written target authorization + backup responsibility → local execution → verification/receipt → delivery manifest → customer acceptance → optional anonymized case study`

Add durable templates for customer scope/authorization, delivery/acceptance, and case-study consent. Existing terms/privacy documents remain explicitly templates pending appropriate legal review and operator details; nothing in the release may imply they are lawyer-approved.

Paid work is a service outcome, not paid access to the MIT-licensed software. The Vercel Hobby site stays a non-commercial technical/open-source surface; paid work is handled privately and executed locally/customer-side.

### 4. Website conversion from documentation to actionable product surface

The live site must make the zero-cost real-product journey obvious without becoming a commercial checkout on Hobby. `/local-runner` must show installation options, prerequisites, the exact CLI lifecycle, supported limits, and links to release/source docs. `/services` may explain that professional support exists but must not function as a paid checkout or hosted data plane on Hobby.

The live release must continue to expose `/release.json` and the exact SHA must match protected `main`.

### 5. Repository hygiene

Close or reconcile stale work that is already delivered. Issues #9–#12 should be closed with references to the shipped deterministic number/date/export/example coverage. PR #3 should be closed as superseded by the delivered Gate-B architecture rather than merged. Temporary ops/audit branches must not be merged to `main`; cleanup is desirable when the connector supports ref deletion, otherwise they remain clearly non-release branches.

### 6. Evidence and acceptance

Release Train 1 is complete only when:

- normal release gate is green on the PR head;
- CodeQL is green;
- SQLite conformance is green on Linux, Windows and macOS;
- a packed/installable CLI smoke test passes;
- canonical CRM fixture passes through the installed `spool` binary;
- the PR merges through protected `main`;
- the merged main SHA independently passes release gate + CodeQL;
- GitHub Release `v1.0.0` exists and points to the exact merged SHA;
- production Vercel build is exact-SHA bound;
- public `/release.json` matches the merged SHA;
- external Chrome production smoke passes with no runtime/network/error logs;
- Vercel reports no runtime error clusters for the release.

## Release Train 2: production expansion

### 7. Streaming local CSV ingestion

The Local Runner must stop materializing the entire source file in memory. Introduce a streaming UTF-8 CSV reader with a finite-state parser capable of commas, quotes, escaped quotes, CRLF/LF, and quoted embedded newlines. It must expose deterministic row iteration plus content hashing/snapshot metadata over the same bytes that are parsed.

Browser Studio remains unchanged and retains its 50 MiB boundary. Streaming is for the Node Local Runner only.

The command service must execute batches incrementally. Memory should be bounded primarily by parser state + one batch + bounded diagnostics. Dry-run/inspection may use bounded reservoir/representative samples rather than retaining the full dataset. Source row count and SHA-256 snapshot must still be exact.

Crash/replay semantics remain source-range bound. Checkpoints and batch identities must continue to use deterministic source row ranges. A streaming resume may rescan/parse from the beginning to reach the next batch boundary if necessary; correctness is preferred over premature seek complexity.

Add load/soak tests for at least 100 MiB, 256 MiB, 500 MiB and a generated 1 GiB-equivalent stream/file where CI resource limits permit. If a full 1 GiB CI artifact is impractical, test the parser with a generated stream whose total bytes exceed 1 GiB without retaining it in memory and separately run a filesystem migration at the largest safe CI size. Report actual peak RSS/elapsed time in evidence; do not claim a size that was not tested.

### 8. Lease renewal for long-running jobs

Long Local Runner jobs must renew their lease before expiry. Renewal must preserve the same fencing token for the active owner and fail closed if ownership/token changed. The target continues to verify fencing inside each target transaction. Add a short-TTL test that would fail without renewal and prove a legitimate long-running migration completes while a stale writer is still fenced out.

### 9. PostgreSQL Gate C

PostgreSQL becomes supported only after implementing the same safety contract as SQLite:

- explicit connector descriptor and target identity;
- credential references resolved at execution time, not embedded in requests/receipts;
- live target schema/contract fingerprinting;
- transactional row writes and durable per-batch reconciliation evidence in the same target transaction;
- exact idempotent replay semantics;
- post-crash reconciliation;
- lease/fencing appropriate to a networked database;
- bound approvals including exact target contract and effects;
- deadlock/serialization/network disconnect/restart fault tests;
- exact row accounting and ledger completeness verification;
- commit-bound receipt;
- conformance tests against a real PostgreSQL instance in CI when a zero-cost ephemeral service container is available.

Initial Gate-C write scope is intentionally `INSERT` into an existing ordinary table. `upsert`, `delete`, `replace`, `truncate`, schema creation, and destructive DDL remain unsupported until separately designed and approved.

PostgreSQL credentials are supplied only through environment/credential references. The web/Vercel surface never receives them.

### 10. Gate-C release rule

Do not merge PostgreSQL as production supported if CI cannot run the real database conformance/fault suite. A code-only adapter with mocked tests may exist on a feature branch, but it is not a delivered capability. If zero-cost GitHub Actions service containers can run PostgreSQL, use them and require the conformance job in branch protection before the capability is documented as production-ready.

## Explicitly deferred

The following are not part of this commercial-ready milestone because they do not help the first revenue loop enough to justify cost/complexity:

- hosted raw-row ingestion;
- paid Vercel upgrade;
- payment gateway;
- SaaS subscriptions;
- RBAC/SSO/control plane;
- MySQL and broad connector count;
- destructive database operations;
- regulatory certification;
- automated tax/legal advice.

## Commercial-ready definition

SPOOL is commercially ready when the released open-source product can be installed and operated by a customer locally, the supported production migration scopes are evidence-backed, customer authorization/delivery/acceptance can be handled professionally without paid infrastructure, and every unsupported capability is explicit and fail-closed.