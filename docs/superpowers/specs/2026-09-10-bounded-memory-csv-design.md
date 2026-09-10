# Bounded-Memory CSV Execution Design

## Goal

Make the SPOOL Local Runner process large UTF-8 CSV files with memory usage bounded by parser and batch limits rather than total source size, while preserving the existing Gate-B correctness contract: content-bound source identity, explicit planning, dry-run evidence, bound approval, target-contract validation, lease/fencing, atomic SQLite batch ledger, crash reconciliation, row accounting, verification, and commit-bound receipts.

## Scope

This change applies only to the customer-local filesystem CSV → existing ordinary SQLite table INSERT path. Browser Studio remains intentionally capped at 50 MiB and continues to use the in-memory browser parser. The Local Runner keeps the current 256 MiB default source ceiling during the first streaming release; the ceiling may be raised only after bounded-memory tests and cross-platform conformance pass. PostgreSQL is not part of this change.

## Core architecture

The Local Runner will no longer read the complete source into a `Buffer`, decode it into a complete string, parse every row into one array, and then repeatedly slice that array. Instead it will create a durable customer-local snapshot file by streaming the original source once through a SHA-256 hasher and an atomic temp-file copy. The snapshot identity remains `spool-source-snapshot-v1` over `{kind,path,size,contentSha256}`; the source path in the identity remains the canonical original path so the semantic source identity does not change merely because execution uses a private snapshot copy.

All later inspection, dry-run, approval and execution operations consume that immutable snapshot. This prevents a source mutation after approval from changing the bytes being executed. The original file is revalidated against the approved snapshot before target mutation begins; if its current size/hash differs, execution fails with `SOURCE_CHANGED` before the first target write. The snapshot is retained for nonterminal runs so deterministic recovery is possible, and removed after verified completion. Cleanup failures cannot downgrade a durable COMPLETE result.

## Streaming CSV parser

Add a Node-only streaming CSV reader under `src/connectors/filesystem/stream-csv.js`. It must provide the same syntax and safety semantics as `parseCsv`: quoted commas, escaped quotes, CRLF/LF, multiline quoted fields, empty-header rejection, duplicate-header rejection, unsafe-header rejection, row-width validation, maximum cell length, row and column limits, strict UTF-8 decoding, and the same stable error codes. It must correctly handle UTF-8 code points, CRLF pairs, escape pairs and quoted fields split across arbitrary byte-chunk boundaries.

The interface will expose an async iterator yielding `{rowIndex,row}` where `rowIndex` is the zero-based data-row index used by migration evidence. Parser state stores only the current decoded chunk, current cell, current row and header set. It never stores prior data rows. A summary helper will count rows and retain at most the first 1,000 rows for schema inference.

## Snapshot lifecycle

Add `createDurableFileSnapshot(path,{snapshotDir,maxBytes})` and `verifyFileAgainstSnapshot(snapshot)` in `src/connectors/source-snapshot.js`. Snapshot creation opens the canonical original source, creates a temp file inside an application-owned snapshot directory adjacent to the run-state database unless an explicit snapshot directory is configured, streams bytes to the temp file while hashing, fsyncs, validates source metadata did not change during the copy, then atomically renames the temp file to a deterministic name derived from the snapshot ID. Existing `readFileSnapshot()` remains for backward-compatible tests and small helpers but the production command service no longer uses it.

Snapshots are private local artifacts, never exposed through public HTTP endpoints or receipts. The snapshot directory path is not part of approval semantics. `sourceSnapshotId`, original source canonical path, size and content SHA remain the approval and batch identity inputs.

## Command-service flow

`#prepare()` becomes metadata-oriented. It resolves paths, validates plan input, creates or reuses the durable source snapshot, streams the snapshot once to obtain `sourceRows`, headers and a bounded inference sample, creates the plan and target preflight, and returns a prepared source descriptor rather than an in-memory `parsed.rows` array.

`inspect()` returns the same external shape as today, using the bounded sample for `inferSchema` and the streamed total row count for `sourceRows`.

`dryRun()` streams every source row through a compiled migration mapper and target-schema validator. It accumulates only processed/valid/invalid counts and bounded violation samples. It returns the same public dry-run fields as today.

`approve()` binds the same semantic fields as today. Approval never binds snapshot temp paths.

`run()` first verifies the current original source still matches the approved source snapshot, then obtains the target lease/fence. It scans the immutable snapshot sequentially. Rows are transformed into one in-memory batch whose size is bounded by `writeStrategy.batchSize`; valid transformed rows are committed immediately through the existing `MigrationRunner` and `SqliteTarget` atomic ledger path. Invalid rows are counted and summarized but never retained globally. On checkpoint resume, the stream restarts from the beginning and discards rows before the checkpoint's next row offset. This is intentionally O(n) re-scan rather than adding byte-offset indexing in the first version.

Expected batch identities are generated incrementally from deterministic row ranges. Verification uses source-row count, aggregate written/rejected counts, and the target ledger. Receipt fields and semantics do not change.

## Migration engine reuse

Do not add a second mapping implementation. Extend `MigrationEngine` with a single-row or bounded-chunk primitive that uses the same `compileMapping`, `validateOutputRow` and violation grouping semantics as `run()`. Existing browser and unit-test callers continue to use `run(rows,...)`; the streaming command service uses the bounded primitive and aggregates counts.

## Failure and recovery semantics

The following are fail-closed before target mutation: invalid UTF-8, malformed CSV, source over configured ceiling, source changed during snapshot, original source changed after snapshot/approval, invalid target contract, missing approval, stale approval, and checkpoint offset not aligned to a deterministic batch boundary.

If target commit succeeds but checkpoint persistence fails, the existing target ledger/reconciliation behavior remains authoritative. If the process crashes, the durable snapshot and checkpoint remain. If a later run observes a COMPLETE durable run record, it returns the existing receipt and ignores any obsolete snapshot/checkpoint cleanup artifacts.

## Memory contract

For Local Runner execution, resident data attributable to source processing must be O(max parser chunk + max cell + one source row + one transformed batch + bounded violation samples), not O(total source size). Tests must prove that a large generated CSV can complete under a deliberately constrained Node heap that would be unable to hold the entire source and parsed object graph.

The first release keeps the 256 MiB default `maxSourceBytes` to limit disk/time blast radius. Raising that default is a separate evidence-backed change after the bounded-memory path is proven.

## Security

Snapshot files are created with owner-only permissions where supported, inside an application-controlled directory, and written using exclusive temp-file creation followed by atomic rename. No source bytes, target bytes, paths outside existing customer-local interfaces, or secrets are added to receipts or public logs. Path-policy protections remain in force for the original source and target. Snapshot filenames are derived from snapshot IDs, not user-controlled path fragments.

## Test requirements

Add parser-parity tests comparing the streaming parser with `parseCsv` across normal CSV, escaped quotes, CRLF/LF, multiline quoted fields, empty cells, unsafe/duplicate headers, width mismatch, oversized cells, invalid UTF-8 and adversarial chunk boundaries.

Add source-snapshot tests proving bounded-memory copy/hash behavior, mutation-during-copy detection, deterministic snapshot identity, source revalidation, private file mode where supported, snapshot reuse, cleanup behavior and no COMPLETE-state downgrade if cleanup fails.

Add command-service tests proving inspect uses bounded samples but exact row counts, dry-run streams without retaining output, run batches deterministically, source mutation before execution prevents all writes, crash/reconciliation still avoids duplicates, checkpoint resume re-scans safely, and terminal receipts preserve existing semantics.

Add a low-heap subprocess test that generates a CSV substantially larger than the chosen heap budget and completes inspect/dry-run/run without `heap out of memory`. Keep the fixture generation streaming so the test itself does not materialize the file. Add the new tests to Linux/macOS/Windows conformance where filesystem semantics apply.

## Release criteria

The feature branch may merge only when the full `npm run check`, packed CLI verification, real built-browser smoke, Linux/macOS/Windows SQLite conformance and CodeQL are green. Browser Studio behavior must remain unchanged. After merge, rerun the same gates on the exact merged `main` SHA before publishing any follow-on release.
