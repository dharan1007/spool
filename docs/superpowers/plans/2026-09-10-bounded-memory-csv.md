# Bounded-Memory CSV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Local Runner's whole-file CSV materialization with an immutable customer-local source snapshot and bounded-memory streaming execution while preserving Gate-B correctness semantics.

**Architecture:** The Local Runner creates a content-bound durable snapshot by streaming the canonical source to an application-owned file while hashing it. A Node-only async CSV iterator consumes the immutable snapshot; inspect retains only a bounded inference sample, dry-run aggregates counts/violations, and run keeps only one target batch in memory while reusing the existing approval/fencing/ledger/reconciliation/receipt path. Browser Studio remains unchanged.

**Tech Stack:** Node.js 22 ES modules, `node:fs` streams/promises, `TextDecoder`, SHA-256, better-sqlite3 12.10.1, node:test, GitHub Actions Linux/macOS/Windows matrix.

**Spec:** `docs/superpowers/specs/2026-09-10-bounded-memory-csv-design.md`

## Global Constraints

- Browser Studio continues to use `parseCsv` and remains capped at 50 MiB.
- Local Runner keeps the default `maxSourceBytes` at 256 MiB in this change.
- The semantic source snapshot algorithm remains `spool-source-snapshot-v1` over the canonical original path, size, and content SHA-256.
- Snapshot temp paths never enter approval, batch identity, receipt, or public HTTP data.
- SQLite production writes remain INSERT-only into an existing ordinary non-triggered table.
- No target mutation may occur after source revalidation failure.
- Existing lease/fencing, atomic ledger, commit-before-checkpoint reconciliation and COMPLETE-state semantics remain authoritative.
- Production source processing memory must be bounded by parser state + one configured write batch + bounded violation evidence, never total source size.
- All new behavior follows RED → GREEN TDD and the final branch must pass `npm run check`, `npm run pack:verify`, built Chrome smoke, cross-platform SQLite conformance, and CodeQL.

---

### Task 1: Streaming CSV parser parity

**Files:**
- Create: `src/connectors/filesystem/stream-csv.js`
- Create: `tests/stream-csv.test.js`

**Interfaces:**
- Produces: `streamCsvRows(path, options) -> AsyncGenerator<{rowIndex:number,row:object}>`
- Produces: `inspectCsvStream(path, options) -> Promise<{headers:string[],rowCount:number,sampleRows:object[]}>`
- Consumes existing stable errors from `src/core/errors.js`.

- [ ] **Step 1: Write failing parser-parity tests.** Cover quoted commas, doubled quotes, CRLF/LF, multiline quoted fields, UTF-8 multibyte characters split at byte boundaries, header validation, width mismatch, max cell/rows/columns, and invalid UTF-8. Force tiny `highWaterMark` values (1–7 bytes) so delimiters and code points split across chunks.
- [ ] **Step 2: Run the focused test and confirm RED because `stream-csv.js` does not exist.** Command: `node --test tests/stream-csv.test.js`.
- [ ] **Step 3: Implement the minimal async parser.** Use `createReadStream`, `TextDecoder('utf-8',{fatal:true})`, parser state `{quoted,cell,row,headers,rowIndex,pendingCR}` and an internal async generator. Header names must use the same trim/unsafe/duplicate rules as `parseCsv`. Each yielded row must use `Object.create(null)` and exact zero-based data row indices.
- [ ] **Step 4: Run focused tests to GREEN, then run `node --test tests/csv.test.js tests/stream-csv.test.js` to prove legacy/browser parser behavior did not change.**
- [ ] **Step 5: Commit parser + tests.** Commit message: `feat: add bounded-memory CSV iterator`.

### Task 2: Durable streaming source snapshot

**Files:**
- Modify: `src/connectors/source-snapshot.js`
- Create: `tests/source-snapshot-streaming.test.js`

**Interfaces:**
- Produces: `createDurableFileSnapshot(path,{snapshotDir,maxBytes}) -> Promise<{snapshot,snapshotPath,reused}>`
- Produces: `verifyFileAgainstSnapshot(snapshot) -> Promise<true>`
- Produces: `removeDurableFileSnapshot(snapshotPath) -> Promise<void>`
- Existing `readFileSnapshot()` and `createFileSnapshot()` remain available.

- [ ] **Step 1: Write failing tests.** Generate a file with a write stream; require exact snapshot identity across repeated snapshots, deterministic reuse, `SOURCE_TOO_LARGE`, mutation detection, revalidation failure after source replacement, private-mode expectation on POSIX, and successful cleanup.
- [ ] **Step 2: Run `node --test tests/source-snapshot-streaming.test.js` and confirm RED because the new exports are missing.**
- [ ] **Step 3: Implement streaming copy/hash.** Resolve original path, open it read-only, capture stat, `mkdir(snapshotDir,{recursive:true,mode:0o700})`, create a random exclusive temp file with `mode:0o600`, stream fixed-size chunks while updating SHA-256 and enforcing `maxBytes`, `sync()` the destination, re-stat original handle and reject metadata changes, compute the existing semantic identity from the original canonical path, atomically rename temp to `<snapshotId>.csv`, and reuse an existing deterministic snapshot only after verifying its size/hash. Always unlink incomplete temp files in `finally`.
- [ ] **Step 4: Implement revalidation using a streaming SHA-256 of the original file, checking canonical path, regular-file status, size and content digest. Return `SOURCE_CHANGED` on mismatch.**
- [ ] **Step 5: Run focused tests to GREEN and run existing snapshot/batch/checkpoint tests to ensure snapshot identity semantics remain stable.**
- [ ] **Step 6: Commit.** Commit message: `feat: add durable source snapshots`.

### Task 3: Bounded transform accumulator

**Files:**
- Modify: `src/core/migration.js`
- Create: `tests/migration-accumulator.test.js`

**Interfaces:**
- Produces: `MigrationEngine.createAccumulator(mappingEntries, revision, targetSchema) -> {process(row,rowIndex), summary()}`
- `process()` returns `{ok:true,row}` or `{ok:false}` and updates aggregate counts/violations internally.
- `summary()` returns `{processedRows,validRows,invalidRows,violations}` without output-row arrays.
- Existing `run()` behavior and result shape remain unchanged.

- [ ] **Step 1: Write failing equivalence tests.** Feed the same rows to current `run()` and the proposed accumulator; require identical counts and canonical violation code/count/message ordering. Require explicit original row indices in samples.
- [ ] **Step 2: Run focused test and confirm RED because `createAccumulator` is missing.**
- [ ] **Step 3: Extract only the minimum shared transform/violation machinery from `run()`.** Compile mapping once, validate each transformed row with `validateOutputRow`, store at most `sampleLimit` violation samples per group, and never retain successful rows in the accumulator.
- [ ] **Step 4: Make `run()` reuse the same accumulator semantics while retaining output/row revision arrays for existing callers.**
- [ ] **Step 5: Run accumulator, migration, autopilot and correctness-corpus tests to GREEN.**
- [ ] **Step 6: Commit.** Commit message: `refactor: expose bounded migration accumulator`.

### Task 4: Streamed prepare/inspect/dry-run

**Files:**
- Modify: `src/daemon/command-service.js`
- Modify: `src/daemon/run-store.js` only if snapshot metadata persistence needs a new field
- Modify/Create tests: `tests/command-service-streaming.test.js`

**Interfaces:**
- Internal prepared source descriptor: `{snapshot,snapshotPath,sourceRows,headers,sampleRows,sourcePath,targetPath,targetPreflight,plan,request}`.
- Public `inspect()`, `plan()`, `dryRun()`, `approve()` shapes remain backward-compatible.

- [ ] **Step 1: Write failing tests proving `inspect` returns exact total rows but only uses a <=1000-row inference sample, and `dryRun` returns exact aggregate counts without depending on `parsed.rows`.** Include a source larger than the browser 50 MiB limit but below a test service ceiling.
- [ ] **Step 2: Confirm RED against current whole-file implementation by monkey-patching/guarding `readFileSnapshot` is not feasible; instead assert a low-heap subprocess fails on the old path and will pass once streaming is integrated. Keep fixture generation streaming.**
- [ ] **Step 3: Add a deterministic snapshot directory derived from `statePath` (for example `${statePath}.snapshots`) inside `SpoolCommandService.create`, unless `snapshotDir` is explicitly provided.**
- [ ] **Step 4: Rewrite `#prepare()` to create/reuse durable snapshot and call `inspectCsvStream(snapshotPath,{sampleSize:1000,...})`; remove `TextDecoder`, full `bytes`, and `parseCsv` from the production Local Runner path.**
- [ ] **Step 5: Rewrite `dryRun()` to iterate `streamCsvRows(snapshotPath)` through `MigrationEngine.createAccumulator`; keep public fields identical.**
- [ ] **Step 6: Ensure `approve()` continues binding the semantic original-source snapshot and target contract, never snapshotPath.**
- [ ] **Step 7: Run command-service and low-heap focused tests to GREEN.**
- [ ] **Step 8: Commit.** Commit message: `feat: stream local inspect and dry-run`.

### Task 5: Streamed batch execution and deterministic recovery

**Files:**
- Modify: `src/daemon/command-service.js`
- Modify: `src/execution/migration-runner.js` only if an incremental API is required; preserve existing `runBatch()` semantics
- Modify/Create: `tests/command-service-streaming.test.js`
- Modify/Create: `tests/conformance/sqlite-streaming.test.js`

**Interfaces:**
- Existing `MigrationRunner.runBatch({...})` remains the target write primitive.
- Source row ranges remain `{start,endExclusive}` over original data-row indices.

- [ ] **Step 1: Write failing tests for one-batch-at-a-time execution.** Use a small batch size; require ledger ranges/identities to match existing semantics, aggregate rejected counts to be exact, and no duplicate rows after injected commit-before-checkpoint failure/retry.
- [ ] **Step 2: Write failing source-change-before-write test.** Approve against snapshot A, modify the original source, invoke run, assert `SOURCE_CHANGED`, zero target rows, and zero migration ledger entries.
- [ ] **Step 3: Write failing checkpoint resume test.** Seed/produce a checkpoint at a batch boundary, restart service, require the immutable snapshot to re-scan/skip earlier rows, reconcile committed batches and finish exactly once.
- [ ] **Step 4: Implement `run()` source revalidation before lease acquisition/target mutation.**
- [ ] **Step 5: Replace `allRanges` + `parsed.rows.slice()` with a streaming loop.** Maintain `{batchStart,batchSourceCount,batchValidRows}`; each source row increments the source range regardless of validity. At a configured batch boundary, create the exact batch identity for that source range and call `runner.runBatch` with only valid transformed rows. Empty-valid batches must still have deterministic accounting: either write a zero-row ledger entry if the target primitive already supports it, or explicitly preserve expected identities only for committed non-empty batches and make verification semantics match existing ledger rules. Choose one path and cover it with tests; do not silently change identity semantics.
- [ ] **Step 6: During resume, discard rows whose `rowIndex < checkpoint.nextOffset`; fail if checkpoint falls inside a deterministic configured batch boundary.**
- [ ] **Step 7: Accumulate exact source/written/rejected counts and bounded violation summaries during the same pass. Generate expected batch identities deterministically from observed source ranges, then call existing `verifyMigration` and `createMigrationReceipt`.**
- [ ] **Step 8: On verified COMPLETE, persist completion first, then best-effort clear checkpoint and durable snapshot. Cleanup failure must not call `runs.fail`. Keep snapshot for nonterminal failures/crashes.**
- [ ] **Step 9: Run streaming command-service and SQLite conformance tests to GREEN.**
- [ ] **Step 10: Commit.** Commit message: `feat: stream fenced SQLite execution`.

### Task 6: Bounded-memory proof and cross-platform fault suite

**Files:**
- Create: `tests/streaming-memory.test.js`
- Modify: `.github/workflows/ci.yml` if a dedicated constrained-heap command is needed
- Modify: `package.json` only if a named test script improves reproducibility
- Modify: `tests/conformance/sqlite-faults.test.js` or add focused streaming fault cases

**Interfaces:**
- No new production API.

- [ ] **Step 1: Write a subprocess harness that launches Node with a constrained old-space size and streams generation of a CSV whose full parsed representation cannot fit that heap.** Keep runtime practical for CI; use repetitive but valid rows and a small SQLite batch size.
- [ ] **Step 2: Require inspect + dry-run + approved run + verification + receipt under the constrained heap. Assert exact source/written/rejected counts and target row count.**
- [ ] **Step 3: Add fault cases for invalid UTF-8 crossing chunk boundaries, malformed quoted record near EOF, max-source breach during streaming copy, target lock contention after streaming prepare, and source deletion/change before run.**
- [ ] **Step 4: Run the test locally via CI-triggered PR and inspect actual max-heap behavior. If runtime is too high, reduce fixture cardinality while preserving the proof that whole-file materialization would exceed the configured heap.**
- [ ] **Step 5: Run Linux/macOS/Windows SQLite conformance and package verification.**
- [ ] **Step 6: Commit.** Commit message: `test: prove bounded-memory local execution`.

### Task 7: Documentation, release boundary and final verification

**Files:**
- Modify: `README.md`
- Modify: `docs/LOCAL_RUNNER.md`
- Modify: `SECURITY.md`
- Modify: `ROADMAP.md`
- Modify: `src/product-surface.js` only if Local Runner copy currently states whole-file behavior or a lower capability than verified
- Modify: `tests/commercial-readiness.test.js` or product-surface tests as required

**Interfaces:**
- Public supported default remains 256 MiB in this release; wording changes from in-memory to bounded-memory customer-local execution.

- [ ] **Step 1: Write failing documentation/product contract tests if user-facing copy needs to guarantee bounded-memory local execution while preserving the 50 MiB Browser Studio boundary and 256 MiB default Local Runner ceiling.**
- [ ] **Step 2: Update docs with snapshot lifecycle, disk-space requirement, crash/recovery behavior, source-change failure semantics, cleanup behavior, and the unchanged unsupported boundaries.**
- [ ] **Step 3: Run `npm run check` and `npm run pack:verify`.**
- [ ] **Step 4: Open/update a draft PR and wait for release-gate + CodeQL; inspect every job and review thread.**
- [ ] **Step 5: After all PR checks pass, mark ready, re-check main SHA, merge, then independently verify the exact merged main SHA with release-gate, browser smoke, cross-platform SQLite, and CodeQL.**
- [ ] **Step 6: Do not raise `maxSourceBytes`, publish a new release, or modify canonical production deployment unless the merged-main evidence is green and a separate release decision is made.**
