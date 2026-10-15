# Real SQLite read-only snapshot and independent value readback

**Implementation:** `src/connectors/sqlite/source-readonly.js`

**Release status:** source/readback **qualification candidate**, not a production-enabled `sqlite.source` connector and not an authorization to execute target mutations. Existing `capabilities/matrix.json` and `src/platform/production-policy.js` remain unchanged. Approved v1.1.2 migration operations remain filesystem CSV → existing ordinary SQLite table, INSERT-only.

## Implemented, genuine SQLite I/O
- Opens an **existing** SQLite file with `better-sqlite3` `readonly: true, fileMustExist: true`, turns on SQLite `query_only`, begins a read transaction and establishes a snapshot with the first schema SELECT.
- Multiple table reads use the **same SQLite snapshot** and maintain transactional consistency for the duration of the reader, subject to SQLite's documented WAL/rollback journal rules. Tests use a **second real writer connection in WAL mode** and prove concurrent committed writes are not visible until a new snapshot opens.
- Iterates genuine table records, with a hard declared 1,000,000-row maximum and no whole-table in-memory accumulation; `safeIntegers(true)` preserves integers larger than JS's safe number range. Rejects unknown/hidden columns, views, virtual and internal/system tables.
- Binds explicit expected rows to actual target reads by a declared SQLite PK or nonpartial UNIQUE key. Uses prepared parameterized `SELECT`, limits results to 2 for fail-closed ambiguity detection, and compares all visible table fields including NULL, text, BLOB bytes and value-preserved integers.
- Returns `VERIFIED`, `MISMATCH`, `INDETERMINATE` or `NOT_VERIFIED`; classifies missing, wrong-value and ambiguous expected results **without returning raw customer values**.
- `VERIFY` means **only the explicitly supplied expected records in a single table were read back and matched**. It does NOT mean every table row, the target's set of extra rows, the prior write ledger or an entire database were independently verified. The output says this explicitly.
- Transactionally coherent readbacks do not use `ATTACH`; no distributed cross-engine atomicity is claimed.

## Real executable API
```js
import { SqliteSnapshotReader } from './src/connectors/sqlite/source-readonly.js';

const reader = new SqliteSnapshotReader({path:'/secure/customer.sqlite',maxRows:100000});
try {
  const sourceContract = reader.table('customers');
  const result = reader.verifyExpectedRows({
    table:'customers',
    keyColumns:['id'],
    expectedRows:[{id:'0007',name:'Ada'}]
  });
  if (result.status !== 'VERIFIED') throw new Error('Do not mark migration reconciled');
  // Rows and credentials never leave this process unless the trusted caller exports them.
} finally {
  reader.close();
}
```

## Qualification gates before production connector promotion
1. Bind actual data-owner approved expected output to a source-snapshot and plan fingerprint; do not trust arbitrary user-provided expected rows as independent truth.
2. Derive expected data under the actual production transformation plan, not synthetic fixtures, and reconcile **all** expected/extra target keys. Record baseline target state for append-only migrations.
3. Enforce a trustworthy authenticated/authorized caller and system allow-root/realpath path checks before exposing this API through daemon, CLI or remote service.
4. Validate cross-platform Windows DACL protection, symlinks/hardlinks, corruption, SQLite `integrity_check`, WAL checkpoints, snapshot starvation, and backup/restore on representative devices.
5. Add durable readback checkpointing / incremental coverage for large tables (current API bounds expected rows at 10k and streaming at 1M).
6. Pin independently reviewed input/output schema versions, connector constraints, and table identity. Include generated, FTS/virtual, trigger and migration-history cases in explicit reject tests.
7. Run sustained real fault tests, large-table load, cancellation/interruption and cross-platform CI equivalents. Current Cloudflare build validates its Linux implementation but does not establish enterprise availability or SLA.
8. Re-run the **exact release SHA** 14-gate qualified owner test suite and Ed25519-sign the new immutable release outside Cloudflare; independently verify the resulting deployed package.

**Do not** change `sqlite.source` from UNSUPPORTED to PRODUCTION, or `sqlite.verified-repair` from unsupported, until the above evidence is collected.

## Threat and correctness limitations
- A malicious producer can supply falsified expected rows. Comparison proves actual SQLite readback against those supplied values only, not source-to-target semantic authenticity.
- Read consistency spans tables in the same SQLite DB file / transaction and does not imply shared MVCC with PostgreSQL or MySQL.
- `digestTable` hashes a **transactionally observed iteration order**, not a stable order-independent table identity. Do not use it as a cross-run proof without deterministic key ordering.
- No credentials, sockets, CDC, writes, target repair, semantic currency conversion or automatic migration are performed.
- Readback returns counts and digest information which can themselves be sensitive; apply customer data-processing agreements and scoped disclosure before export.
