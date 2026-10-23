# Run monitor

## What execution looks like

Executing a migration calls the engine `run()` once. The engine:

1. takes/extends a lease with a fencing token,
2. transitions the durable state machine (`FULL_LOAD_RUNNING`),
3. streams the source in batches, writing through the SQLite connector,
4. records each batch in the internal ledger (`__spool_batch_ledger`),
5. checkpoints progress safely (crash-safe),
6. verifies (`row_accounting`, `ledger_complete`) in the `VERIFYING` phase,
7. completes to a **receipt** (`receipt.record.counts`).

The adapter sits above this and drives the UI from three sources:
- live service status (`migration.status`),
- the Console activity log (per-step events),
- durable transition history (`migration.transitions`).

## Monitoring surfaces

| Surface | Call | Shows |
| --- | --- | --- |
| Status | `migration.status` | record + engine run status + durable state + recovery hint |
| History | `migration.history` | migrations with most recent status, bound plan, timestamps |
| Activity | `migration.events` | per-operation codes (`MIGRATION_CREATED`, `PLAN_CREATED`, `DRY_RUN_COMPLETE`, `MIGRATION_APPROVED`, `MIGRATION_RUN_STARTED`, `MIGRATION_RUN_RESULT`, `MIGRATION_RUN_FAILED`, `MIGRATION_COMPLETE`) |
| Transitions | `migration.transitions` | full state machine history incl. reasons, principal, fence token |
| Verification | `migration.verification` | counts and check results from the engine |
| Receipt | `migration.receipt` | signed receipt object from the engine |

## Interruption and recovery

A crash (power loss, forced kill) leaves the durable state machine and ledger
consistent on disk. On relaunch the Console reads `restartDecision` from the
engine:

- a resumable interrupted run resumes from its checkpoints **bound to a fresh
  approval** (the old nonce was consumed at lease time),
- an ambiguous state fails closed with instructions, never a silent replay,
- `MIGRATION_ALREADY_RUNNING` guards a second execute attempt while the
  adapter knows a run is in flight, and the engine's own lease fencing
  prevents a second process from double-writing.

Resumption is bound to explicit durable state (checkpoints + ledger), not to
Console memory: after a crash the correct state is rebuilt from disk.
