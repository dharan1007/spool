# SPOOL Local Runner

The Local Runner is the production target-mutation surface for SPOOL Gate B. It runs on the machine that owns the source CSV and SQLite database. Source rows, target credentials, and database contents are not uploaded to the hosted Browser Studio.

## Requirements

- Node.js 22 or newer.
- Git.
- A UTF-8 CSV source file.
- An existing ordinary SQLite database and table with a schema compatible with the declared target contract.
- Source, target, and state files must remain inside the allow-roots supplied to the CLI.

Browser Studio intentionally limits selected files to 50 MiB. The Local Runner currently permits sources up to 256 MiB by default. It still materializes the source in memory, so leave substantial RAM headroom and do not treat 256 MiB as a streaming/1-GB claim.

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

Inspection binds the source snapshot and checks the live SQLite table contract.

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

Do not approve a migration merely because the command ran. Check valid/rejected counts and violation classes. Revise the declared contract/mapping when the result is not acceptable.

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

The SQLite path uses a durable execution lease/fencing token, commits migrated rows and SPOOL batch-ledger evidence in the same SQLite transaction, and reconciles exact target evidence before replay after a crash.

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

The final receipt binds the release commit, plan, source snapshot, target contract, batch identities, counts, violation summary, and verification result.

## Current Gate B boundaries

Supported now: UTF-8 filesystem CSV, existing ordinary SQLite table, insert-only writes, 1–10,000 rows per batch, customer-local execution, snapshot binding, target preflight, approval, fencing, reconciliation, verification, and receipts.

Not claimed: PostgreSQL/MySQL execution, hosted raw-row ingestion, delete/truncate/upsert/replace, triggered or virtual SQLite targets, 1-GB streaming, or remote credential custody.

For a known working fixture, see `examples/crm-export/` and `tests/crm-example.test.js`.
