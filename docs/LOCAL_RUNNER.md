# SPOOL Local Runner

The Local Runner is the production target-mutation surface for SPOOL Gate B. It runs on the machine that owns the source CSV and SQLite database. Source rows, target credentials, durable snapshots, and database contents are not uploaded to the hosted Browser Studio.

## Requirements

- Node.js 22 or newer.
- Git.
- A UTF-8 CSV source file.
- An existing ordinary SQLite database and table with a schema compatible with the declared target contract.
- Source, target, and state files must remain inside the allow-roots supplied to the CLI.
- Enough local disk space for a source-sized durable snapshot plus SQLite target/WAL growth and ordinary filesystem headroom.

Browser Studio intentionally limits selected files to **50 MiB**. The Local Runner defaults to a **256 MiB** source ceiling and now uses bounded-memory streaming: it does not retain the whole CSV or the whole transformed dataset in one JavaScript array. The limit remains deliberate; 256 MiB is not a 1-GB/unlimited-file claim and does not remove the need for sufficient RAM, disk, and database headroom.

## Snapshot and recovery lifecycle

Before planning, SPOOL copies the source incrementally into a customer-local durable snapshot while computing its SHA-256 content digest. The snapshot identity binds the canonical original path, exact byte count, and content digest. On POSIX systems the snapshot file is owner-only; its generated filename is cross-platform safe and is not part of the semantic approval/receipt identity.

`inspect`, `dry-run`, and execution stream rows from that snapshot. Schema inference keeps only a bounded sample; validation keeps bounded violation samples; execution keeps the current target batch and bounded evidence. This makes memory usage primarily a function of parser state, sample limits, and batch size instead of source-file size. The release gate includes a source larger than the 50 MiB Browser Studio limit executed with V8 `--max-old-space-size=48` and exact target/receipt verification.

An approved run also revalidates the original source against the approved snapshot **before any target write lease is acquired**. If the approved source is changed, replaced, or missing, execution stops with `SOURCE_CHANGED` and target mutation does not begin.

For restart/recovery, SPOOL loads the exact durable snapshot, re-scans it sequentially from the beginning, discards rows before the durable whole-batch checkpoint, and reconciles target batch evidence before replay. A commit-before-checkpoint crash therefore does not duplicate rows. After VERIFIED completion and durable receipt persistence, the per-migration snapshot directory is cleaned. A failed or interrupted migration retains its snapshot so the same approved bytes can be resumed; do not manually delete an abandoned run's snapshot if you still intend to resume it.

## 1. Install and verify the exact checkout

```bash
git clone https://github.com/dharan1007/spool.git
cd spool
npm ci
npm run check
```

For a released checkout, bind receipts to the exact commit:

```bash
export SPOOL_COMMIT_SHA="$(git rev-parse HEAD)"
```

Create an approval signing key locally. Do not commit it and do not put it in `migration.json`:

```bash
export SPOOL_APPROVAL_KEY="$(openssl rand -hex 32)"
```

On PowerShell, set the same variables explicitly, for example:

```powershell
$env:SPOOL_COMMIT_SHA = (git rev-parse HEAD)
$env:SPOOL_APPROVAL_KEY = "<a locally generated high-entropy secret>"
```

## 2. Prepare the local data directory

Example layout:

```text
data/
  customers.csv
  customers.db
  spool-state.db        # created/used by SPOOL
  spool-state.db.snapshots/  # durable recovery snapshots, created as needed
migration.json
```

Create the destination table before running SPOOL. Example:

```sql
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT
) STRICT;
```

## 3. Create `migration.json`

This is a complete minimal example. Paths are constrained by `--source-root` and `--target-root`; raw passwords and connection strings do not belong in this file.

```json
{
  "migrationId": "mig_customers_001",
  "principal": "operator:local",
  "planInput": {
    "planRevision": 1,
    "sourceRef": {
      "connector": "filesystem",
      "connectionId": "source-local",
      "resource": "customers.csv",
      "path": "./data/customers.csv"
    },
    "targetRef": {
      "connector": "sqlite",
      "connectionId": "target-local",
      "resource": "customers",
      "path": "./data/customers.db",
      "table": "customers"
    },
    "targetSchema": [
      { "name": "id", "type": "integer", "nullable": false },
      { "name": "name", "type": "string", "nullable": false },
      { "name": "created_at", "type": "local_datetime", "nullable": true }
    ],
    "mapping": [
      {
        "target": "id",
        "expr": { "op": "cast_number", "value": { "op": "field", "name": "id" } }
      },
      {
        "target": "name",
        "expr": { "op": "trim", "value": { "op": "field", "name": "name" } }
      },
      {
        "target": "created_at",
        "expr": { "op": "parse_local_datetime", "value": { "op": "field", "name": "created_at" } }
      }
    ],
    "mappingRevision": 1,
    "writeStrategy": { "mode": "insert", "batchSize": 1000 },
    "verification": { "checks": ["row_accounting", "ledger_complete"] },
    "risk": { "level": "medium", "approvals": ["target_write"] },
    "capabilityAssumptions": {
      "source": { "snapshotBinding": true },
      "target": {
        "transactions": true,
        "atomicBatchLedger": true,
        "reconcileAfterCrash": true,
        "fencing": true
      }
    }
  }
}
```

`local_datetime` preserves a wall-clock timestamp such as `2026-09-07T11:48:01.000` without silently inventing a timezone. Use `date` for actual dates/instants supported by the deterministic parser. A timezone conversion must be an explicit semantic choice; SPOOL does not silently reinterpret a floating timestamp as UTC.

## 4. Inspect before mutation

Use the same roots and state path for every command:

```bash
node src/cli/spool.js inspect \
  --request migration.json \
  --source-root ./data \
  --target-root ./data \
  --state ./data/spool-state.db
```

Inspection creates/reuses the durable content-bound source snapshot, streams the source for row count/schema sampling, and checks the live SQLite table contract. The returned customer-facing payload exposes semantic source identity and counts, not the private snapshot path.

## 5. Review the authoritative plan

```bash
node src/cli/spool.js plan \
  --request migration.json \
  --source-root ./data \
  --target-root ./data \
  --state ./data/spool-state.db
```

## 6. Dry-run the real transforms

```bash
node src/cli/spool.js dry-run \
  --request migration.json \
  --source-root ./data \
  --target-root ./data \
  --state ./data/spool-state.db
```

Dry-run reuses the durable snapshot and streams every row through the exact transform/validation semantics without materializing successful output rows. Do not approve a migration merely because the command ran. Check valid/rejected counts and violation classes. Revise the declared contract/mapping when the result is not acceptable.

## 7. Create bound approval evidence

The approval is signed locally and bound to the exact plan, source snapshot, target contract, effects, principal, expiry, and nonce. `--expires` must use canonical UTC ISO form including milliseconds, as shown below.

```bash
node src/cli/spool.js approve \
  --request migration.json \
  --source-root ./data \
  --target-root ./data \
  --state ./data/spool-state.db \
  --expires 2026-12-31T23:59:59.000Z \
  --nonce first-run \
  --out approval.json
```

If source bytes or the target contract change after approval, execution fails closed and a new inspection/approval cycle is required.

## 8. Execute the migration

```bash
node src/cli/spool.js run \
  --request migration.json \
  --approval approval.json \
  --source-root ./data \
  --target-root ./data \
  --state ./data/spool-state.db \
  --out run-result.json
```

The SQLite path revalidates the original approved source, uses a durable execution lease/fencing token, streams the immutable snapshot in bounded source batches, commits migrated rows and SPOOL batch-ledger evidence in the same SQLite transaction, checkpoints only whole source ranges, and reconciles exact target evidence before replay after a crash.

## 9. Read status, verification, and receipt

```bash
node src/cli/spool.js status \
  --migration-id mig_customers_001 \
  --source-root ./data \
  --target-root ./data \
  --state ./data/spool-state.db

node src/cli/spool.js verify \
  --migration-id mig_customers_001 \
  --source-root ./data \
  --target-root ./data \
  --state ./data/spool-state.db

node src/cli/spool.js receipt \
  --migration-id mig_customers_001 \
  --source-root ./data \
  --target-root ./data \
  --state ./data/spool-state.db \
  --out receipt.json
```

A production success requires verification evidence, not only a zero process exit. The accounting invariant is:

```text
source rows = written rows + rejected rows + explicitly filtered rows
```

The final receipt binds the release commit, plan, source snapshot, target contract, batch identities, counts, violation summary, and verification result. Snapshot cleanup happens only after this verified terminal truth is durable.

## Current Gate B boundaries

Supported now: UTF-8 filesystem CSV, existing ordinary SQLite table, insert-only writes, 1–10,000 source rows per batch, **256 MiB default Local Runner source ceiling**, bounded-memory streaming, customer-local durable snapshots, source revalidation, snapshot cleanup after VERIFIED completion, target preflight, approval, fencing, reconciliation, checkpoint re-scan, verification, and receipts.

Not claimed: PostgreSQL/MySQL execution, hosted raw-row ingestion, delete/truncate/upsert/replace, triggered or virtual SQLite targets, 1-GB/unlimited streaming, or remote credential custody.

For a known working fixture, see `examples/crm-export/` and `tests/crm-example.test.js`.
