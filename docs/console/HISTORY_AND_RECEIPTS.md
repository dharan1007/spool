# History and receipts

## History

`migration.history` lists migrations for a workspace (or all workspaces),
combining the Console index (name, design timestamps) with the last known
status. Statuses: CREATED, PLANNED, DRY_RUN, AWAITING_APPROVAL, APPROVED,
RUNNING, FAILED, COMPLETE. The durable engine state remains authoritative;
whenever the engine service is loaded the adapter re-reads it and reconciles
the cache.

## Columns shown

- migration id (mig_uuid), name, created/updated timestamps
- design summary: source/target paths, table, batch size, revision counters
- last status + last engine state
- plan/dry-run/approval presence — indicating how far the journey went

## Receipts

After success, the engine produces a signed **receipt** (`migration.receipt`):
`receiptId` (sha256 over the canonical record), release identity, migration
and plan ids, target identity, batch identities, counts (source rows, written
rows, rejected rows), timing and the verification status. A receipt exists
only if verification succeeded (`RECEIPT_REQUIRES_VERIFICATION`).

Receipts answer "what exactly did this run do?" without trusting the Console:
the data comes from the engine and is bound to the same plan/snapshot/contract
ids the approval signed.

## Evidence bundles (export)

Use `evidence.export` to write a bundle into a directory you choose. A bundle
contains the migration design, the recorded plan/dry-run/approval snapshots,
the engine status summary and activity trail, plus a `manifest.json` with
sha256 hashes over each member file. `evidence.verify` recomputes the hashes;
any modification fails with `EVIDENCE_BUNDLE_INVALID`. Record: the export is
deliberately presentation-level evidence for operators; cryptographic truth
lives in the engine receipt and the durable state files, which you can archive
as files (`state.db`, `receipts` from the engine directory) for legal-grade
retention.
