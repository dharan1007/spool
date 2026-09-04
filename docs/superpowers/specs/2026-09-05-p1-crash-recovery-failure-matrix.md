# P1 Crash-Recovery and Commit-Ambiguity Failure Matrix

Date: 2026-09-05
Status: audit/design only; implementation blocked until `2026-09-05-hybrid-local-bridge-platform-design.md` is explicitly approved in chat

## Purpose

Close the highest-risk semantic gap before the durable JobStore/runner increment: what SPOOL must do when a source read, target write, target commit, durable checkpoint, verification step, or receipt persistence fails at an inconvenient boundary.

This document does **not** authorize architectural code changes.

## Core rule

SPOOL must optimize for **no silent loss and no unproven replay**, not for pretending every connector can provide global exactly-once semantics.

The durable boundary is a tuple, not a cursor alone:

```text
(plan identity,
 source snapshot identity,
 source cursor/batch identity,
 transformation identity,
 target identity,
 target commit/ack evidence,
 checkpoint sequence)
```

A job may auto-resume only when SPOOL can prove that replay begins strictly after the last durably reconciled target boundary. Otherwise it fails closed into a recovery state.

## Required recovery states

The previous state model needs two explicit non-terminal operator states in addition to `PAUSED` and `FAILED`:

- `RECOVERING` — SPOOL is deterministically reconciling persisted job/checkpoint state with connector-visible state after restart or an ambiguous acknowledgement.
- `RECOVERY_REQUIRED` — automatic reconciliation cannot prove a safe continuation boundary; no further writes may occur until a new plan/restart or an explicitly supported connector recovery action resolves it.

`RECOVERY_REQUIRED` is preferable to silently replaying a potentially committed batch.

## Batch commit protocol

For each batch `N`:

1. derive immutable `batchIdentity` from plan revision + source snapshot + input cursor range + deterministic transformed payload identity;
2. execute the target write under the connector's declared durability/idempotency strategy;
3. obtain connector-native durable commit/ack evidence when available;
4. persist checkpoint `N` and cumulative counters in the metadata JobStore transaction;
5. continue with batch `N+1` only after step 4 commits.

The metadata checkpoint never precedes target durability.

A connector that cannot supply either an idempotent replay key or enough target evidence to reconcile a commit-before-checkpoint crash must declare that limitation. Such jobs are resumable only up to the last unambiguous checkpoint and enter `RECOVERY_REQUIRED` on ambiguous commit outcomes.

## Failure matrix

| Failure point | Persisted/observable evidence | Safe automatic action | Forbidden action |
| --- | --- | --- | --- |
| Before source read | Last durable checkpoint only | Resume from checkpoint cursor | Advance cursor |
| During source read before full batch emitted | No new batch identity | Discard partial batch and reread from checkpoint | Persist partial cursor as committed |
| After full source batch, before transform completes | Batch source range known; no target mutation | Recompute transform deterministically | Treat transform-local progress as durable |
| Validation rejects rows before target write | Deterministic reject set known | Persist only through the normal batch commit path with accepted/rejected counts | Skip a source range without target/checkpoint evidence |
| Before target transaction/write starts | No target mutation | Retry according to connector policy | Mark batch committed |
| Target write fails and transaction is confirmed rolled back | Rollback evidence | Retry only if error is connector-declared transient | Assume partial rows survived |
| Target write fails with unknown rollback/commit outcome | Ambiguous target state | Reconcile by batch identity/target evidence; otherwise `RECOVERY_REQUIRED` | Blindly replay |
| Target commit succeeds, process dies before checkpoint | Target commit may exist; checkpoint absent | Reconcile target using batch identity/commit evidence, then persist recovered checkpoint if proven | Replay merely because checkpoint is absent |
| Target commit response times out | Commit outcome unknown | Query connector-native transaction/target evidence; else `RECOVERY_REQUIRED` | Convert timeout into rollback assumption |
| Checkpoint transaction fails after proven target commit | Target ahead of JobStore | Enter `RECOVERING`; reconstruct checkpoint only from independently proven evidence | Move source cursor without reconciliation |
| Checkpoint commits, process dies before next read | Target and metadata aligned | Resume at next cursor | Re-execute checkpointed batch |
| Pause requested before target write | No in-flight mutation | Pause immediately | Persist synthetic checkpoint |
| Pause requested during target transaction | In-flight target state | Finish to known commit/rollback boundary, checkpoint if committed, then pause | Kill write and assume rollback |
| Cancel requested during target transaction | In-flight target state | Resolve to known boundary before terminal cancellation evidence | Emit terminal receipt before boundary is known |
| Process restart with matching source/target/plan identities | Last checkpoint valid | Enter `RECOVERING`, revalidate identities, resume | Skip identity validation |
| Source snapshot changed since checkpoint | Snapshot mismatch | `RECOVERY_REQUIRED` / require re-plan | Resume old cursor against new snapshot |
| Target identity changed | Destination mismatch | `RECOVERY_REQUIRED` | Continue into replacement target |
| Connector version/capability changed materially | Resume contract mismatch | Require compatibility check/re-plan | Assume old cursor/ack semantics still hold |
| Plan or transformation revision changed | Semantic identity mismatch | Require new job/plan | Resume under modified transform |
| Verification read fails transiently | Writes complete; verification absent | Retry boundedly under connector policy | Mark `COMPLETE` |
| Verification returns mismatch | Durable target exists but proof fails | Terminal verification failure / recovery workflow; emit failure evidence | Mark `COMPLETE` |
| Receipt insert/hash transaction fails | Verification may have passed; terminal receipt absent | Retry receipt persistence idempotently by canonical `receiptId` | Transition to `COMPLETE` without receipt linkage |
| Crash after receipt insert but before job terminal transition | Immutable receipt exists | Reconcile receipt by `jobId`/`receiptId`, transactionally finish terminal link if all invariants hold | Create a second divergent terminal receipt |

## Connector-specific reconciliation requirements

### Filesystem targets

Atomic replacement is safe only when the target connector can distinguish the committed artifact from a temp/in-progress artifact.

Required evidence:

- final canonical path identity;
- deterministic artifact hash and byte/row counts;
- temp file naming scoped to job/batch;
- `fsync`/close before atomic rename;
- directory durability step where supported and required by the platform;
- startup cleanup may delete only provably owned stale temp artifacts, never arbitrary matching files.

For append-style semantics, P1 must not claim resumable exactly-once behavior unless it can prove the last appended batch boundary. Prefer atomic full replacement for bounded file targets in the first release.

### SQLite targets

Required evidence:

- transaction commit is the target durability boundary;
- batch identity must be reconcilable through the declared key strategy, deterministic PK set, or connector verification evidence;
- upsert may be replay-safe only when the plan proves the operation is idempotent under the selected conflict/update semantics;
- plain inserts with generated keys are not automatically replay-safe after an unknown commit unless SPOOL can prove whether the batch landed;
- source/target databases must never be confused with the separate daemon metadata database.

## Batch identity contract

`batchIdentity` must be stable across restart and exclude secrets, timestamps, retry counts, or other volatile runtime data.

Recommended canonical inputs:

```json
{
  "planHash": "sha256:...",
  "sourceSnapshot": "sha256:...",
  "sourceRange": { "after": 4000, "through": 5000 },
  "transformHash": "sha256:...",
  "targetRefHash": "sha256:redacted-identity",
  "payloadHash": "sha256:canonical-transformed-rows"
}
```

The payload hash should be produced incrementally while deterministic rows are emitted so large batches do not require a second full materialization solely for hashing.

## Locking and concurrent ownership

A durable job must have one active execution owner at a time.

P1 should use a lease/epoch model rather than trusting process-local mutexes:

- each runner acquisition increments or assigns an execution epoch;
- checkpoint/state mutations include the expected job `stateVersion` and execution epoch;
- stale processes cannot commit metadata after ownership has moved;
- an expired lease does not prove the previous target transaction rolled back; recovery still reconciles connector-visible state first;
- read-only status/receipt operations do not require execution ownership.

This protects against duplicate local daemon instances, process replacement, and self-hosted orchestration restarts.

## Receipt semantics for non-success outcomes

Receipts should represent terminal evidence, not only success.

Recommended terminal receipt statuses:

- `COMPLETE_VERIFIED`
- `FAILED_BEFORE_MUTATION`
- `FAILED_ROLLED_BACK`
- `FAILED_VERIFICATION`
- `CANCELLED_KNOWN_BOUNDARY`

`RECOVERY_REQUIRED` is not terminal and therefore must not generate a final success/failure receipt that implies the target boundary is known. It may persist an append-only incident/recovery record describing the ambiguity without pretending it is terminal evidence.

## Secret and raw-row isolation through failures

Failure paths are where accidental data leakage is most likely. Therefore:

- connector exceptions must be normalized before persistence/logging;
- connection strings, auth headers, tokens, passwords, and resolved secret material must be structurally excluded from JobStore envelopes;
- raw source/target rows are not persisted in checkpoints, receipts, default logs, or error messages;
- deterministic hashes may be persisted, but hashing is not a substitute for field-level secret exclusion;
- stack traces exposed through API/MCP/CLI must pass the same bounded/redacted error projection.

## Verification properties required before implementation is accepted

The future implementation must use fault injection at every numbered batch boundary and demonstrate these properties:

1. no source range is skipped after a crash;
2. no ambiguous target commit is blindly replayed;
3. no job reaches `COMPLETE` without passing verification and an immutable linked receipt;
4. stale runners cannot persist checkpoints after execution ownership changes;
5. source/target/plan/connector drift blocks resume;
6. repeated recovery is idempotent;
7. secret material and raw rows do not appear in persisted metadata or externally projected errors;
8. existing browser-only kernel/WebMCP behavior remains unchanged.

Minimum recovery integration cases after approval:

- JSONL -> SQLite: crash before commit, after commit/before checkpoint, after checkpoint;
- SQLite -> JSONL: crash during temp write, after fsync, after rename/before checkpoint;
- SQLite -> SQLite: transaction rollback, commit-response ambiguity, commit-before-checkpoint;
- process restart with matching identities;
- restart with source snapshot drift;
- restart with target identity drift;
- two runners racing for the same job;
- verification pass followed by crash before receipt/job terminal linkage;
- injected secret-bearing connector error proving redaction/exclusion.

## Implementation impact after explicit written-spec approval

This validation refines the prior decomposition without changing its order:

1. Increment A — add recovery states, batch identity, transition/ownership contracts, canonical receipt hashing, and tests.
2. Increment B — SQLite JobStore with optimistic state versioning, execution epochs/leases, transactional checkpoints, append-only evidence, and restart recovery tests.
3. Increment C — shared runner with target-ack-before-checkpoint discipline and connector-specific reconciliation.
4. Increment D — command service; only later add `spoold`, CLI, HTTP API, MCP, and bridge surfaces.

No architectural implementation, merge, production deployment, CSP weakening, daemon bind, or new network surface is authorized by this document.
