# SPOOL Capability Limits

Every limit below is enforced in code or asserted in tests. Anything not listed here is not promised.

## Universal boundaries

- Row values of type `Uint8Array`/binary are outside the canonical evidence domain on every engine: batch payload hashing rejects them, so neither row-path nor bulk commits accept binary payloads.
- `writeStrategy.mode` is `insert` only on every target connector; `batchSize` must be between 1 and 10,000.
- Migration and repair approvals expire (`expiresAt`) and bind exact plan, snapshot, contract, effects, principal and nonce. No approval authorizes anything outside its binding.
- Fencing tokens are positive safe integers with a configured TTL (default 5 minutes); stale or expired tokens fail closed.

## filesystem source

- UTF-8 CSV only; malformed encodings and unterminated quotes fail before any target mutation.
- Local Runner default source ceiling 256 MiB (`maxSourceBytes`); Browser Studio input boundary 50 MiB.
- Sources must contain at least one data row; paths stay under the configured allow-root (traversal/symlink/junction contained).

## SQLite target

- Existing ordinary tables only; virtual or triggered tables are refused.
- Single-writer semantics per database file (BEGIN IMMEDIATE); a held write lock fails the run closed with no partial rows or ledger entries.
- No bulk COPY path, no read-after-write verification, no repair execution.

## PostgreSQL

- Sources stream one table per snapshot under `REPEATABLE READ`; tables require a primary key for keyset traversal.
- Whole-database snapshots share one exported MVCC snapshot token across sessions; the exporting transaction must stay open while joiners read.
- Targets require pre-created ordinary or partitioned tables with a primary key for verification.
- Bulk `COPY` uses CSV format with all non-null fields quoted; `NULL` is the unquoted empty field.
- CDC requires `wal_level = logical`, a replication-capable principal and a publication; unconsumed slots retain WAL on the server (monitor slot lag externally).
- Leases and fencing state live in `spool_internal`; catalog discovery always excludes it.
- Reference fault workloads fail closed, never silent: a dropped replication slot is reported absent and must be recreated before capture resumes; a cancelled `COPY` leaves no partial rows and no ledger entry, and the commit surfaces the server cancellation message through the credential boundary.
- Deadlock (`40P01`) and serialization (`40001`) faults are retryable; terminated backends (`57P01`) and read-only violations are classified but not retried.
- Soak plans require the batch id window to fit one full round (`batchSize * writers <= uniqueEnd - uniqueStart`); RPO/RTO records are measured observations of a run, not guarantees.

## MySQL

- Sources read one table per session under `REPEATABLE READ` with a consistent snapshot; tables require a primary key. Snapshots are single-session: there is no cross-session snapshot export.
- Sources must run as least-privilege readers; `DATETIME` values arrive as `Date`, `DECIMAL`/`BIGINT` arrive as strings.
- Targets require pre-created ordinary tables. No read-after-write verification, repair execution or bulk writes.
- Metadata tables (`spool_batch_ledger`, `spool_execution_leases`) live in the target database.

## SQL Server

- Sources stream one table per session under `SNAPSHOT` isolation; the database must have `ALLOW_SNAPSHOT_ISOLATION` on and tables require a primary key.
- Snapshot sessions must belong to principals with zero mutating database rights (e.g. `db_datareader` only); the connector proves this before streaming and refuses otherwise.
- Only the `dbo` schema scope is supported for sources and targets.
- Targets require pre-created ordinary tables. No read-after-write verification, repair execution or bulk writes.
- Metadata tables (`dbo.spool_batch_ledger`, `dbo.spool_execution_leases`) live in the target database.

## Repair and cutover

- Repair applies only to stored `DIFF` evidence for runs in `VERIFICATION_FAILED` status; preconditions (`absent` / `actualRowHash`) fail the operation on any divergence, and re-verification must return `VERIFIED` before any receipt.
- Cutover arms only on the recorded migration or repair receipt, commits only with an unchanged plan and target contract plus a fresh fenced lease; after commit, approve/run/repair are frozen. Abort is terminal for that arming; re-arm creates a new arming.

## Control plane and benchmarks

- `spoold` binds loopback only, requires a ≥32-byte bearer token, validates Host/Origin, and caps bodies (default 1 MiB).
- SPOOL-Bench numbers are local single-run measurements, never cross-machine claims; production readiness is decided by the capability matrix, not by benchmark speed.

## Release integrity, provenance and reproducible builds

- Dist artifacts are identified by `sha256` of file bytes; the canonical artifact root is the hash of `path\0size\0sha256\n` lines in lexicographic path order. Order is fixed by sorted collection, not by root computation.
- Release parity anchors SHA from Git (`git rev-parse HEAD`) to the artifact root of the built `dist`, cross-checking `release.json` and `release-manifest.json`; any disagreement fails the chain closed before signing is considered.
- Signatures are Ed25519 over `SPOOL\0release-parity-v1\0` + canonical JSON only; the public key file under `keys/` is the trust root, and the fingerprint (`ed25519:fpr:<sha256 of SPKI DER>`) must match the enrolled key id on every verification.
- The signing private key is never stored in the repository. Release signing requires an out-of-band secret (`SPOOL_RELEASE_PRIVATE_KEY`); without it, signing commands fail closed.
- Reproducible-build evidence builds `dist` twice into independent temporary directories and rejects the release if the artifact roots differ; the recorded environment fingerprint pins Node, npm, platform, arch, lockfile hash and source tree.
- Root and manifest files (`release.json`, `release-manifest.json`) and host-consumed config (`vercel.json`) are excluded from the artifact root by design; modify the exclusion set through the chain call sites only.
- Envelope verification is a pure function over `(envelope, public key)`; it never trusts mutable process state, and tampered payload, wrong key, wrong commit or wrong domain are all rejected with distinct codes.
