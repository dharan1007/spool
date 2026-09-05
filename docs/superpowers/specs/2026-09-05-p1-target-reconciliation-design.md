# P1 Target Reconciliation Design

Date: 2026-09-05
Status: approved architecture continuation; implementation scoped to protocol only

## Goal

Allow a replacement runner to resume after a target-commit / metadata-checkpoint interruption only when connector-visible evidence proves the exact batch outcome. Unknown outcomes remain fail-closed in `RECOVERY_REQUIRED`.

## Existing invariant

The existing crash-recovery matrix remains authoritative: SPOOL never advances metadata before target durability and never blindly replays an ambiguous target commit. The deterministic browser kernel and current browser/WebMCP behavior remain unchanged.

## Design

### 1. Durable pending-batch intent

Before every target mutation, the shared runner computes a stable `batchIdentity` from only deterministic pre-commit inputs:

- plan identity and revision;
- source identity;
- previous committed source cursor;
- current emitted source cursor;
- transformed payload hash;
- target connector/resource identity;
- cumulative post-batch counts.

No raw rows, timestamps, resolved secrets, retry counts, or connector-native errors participate in the identity.

The runner persists a bounded `pendingBatch` record through the transactional JobStore before invoking `target.write()`. The record contains only the identity, cursors, payload hash, target identity, and cumulative counts required to reconstruct a checkpoint if the connector later proves the commit.

`commitCheckpoint()` atomically installs the checkpoint/counts and clears `pendingBatch`. A crash after target commit but before metadata checkpoint therefore leaves a durable intent describing exactly what must be reconciled.

### 2. Connector reconciliation contract

A connector advertising `capabilityProfile.target.reconcileAfterCrash === true` MUST implement:

```js
reconcileTargetCommit(ctx, request) -> Promise<{
  status: 'COMMITTED' | 'NOT_COMMITTED' | 'UNKNOWN',
  ack?: object
}>
```

`request` contains the target resource plus the bounded pending-batch record and prior checkpoint metadata. It never contains raw rows or resolved secrets.

Semantics:

- `COMMITTED`: connector evidence proves the exact pending batch landed. `ack` must contain enough bounded target evidence for the normal checkpoint path.
- `NOT_COMMITTED`: connector evidence proves the pending batch did not mutate durable target state. The runner may clear the pending intent and replay from the previous committed cursor.
- `UNKNOWN`: evidence is insufficient. The job becomes `RECOVERY_REQUIRED`; no write occurs.

Connector validation fails closed if a connector claims crash reconciliation without implementing the method.

### 3. Runner recovery flow

After execution ownership takeover yields `RECOVERING`:

1. Revalidate the capability-bound plan against live connector manifests.
2. Require an existing `pendingBatch` and `reconcileAfterCrash === true`.
3. Call `target.reconcileTargetCommit()` before any source read or target write.
4. For `COMMITTED`, convert the pending intent plus returned commit evidence into the normal checkpoint representation, persist it, then transition to `RUNNING`.
5. For `NOT_COMMITTED`, clear the pending intent transactionally, then transition to `RUNNING`; source reading restarts from the last committed checkpoint.
6. For `UNKNOWN`, malformed evidence, missing method, or missing pending intent, transition to `RECOVERY_REQUIRED` with normalized/redacted recovery evidence.

### 4. Capability truthfulness

This increment does not upgrade the existing SQLite or filesystem connector capability profile. Both remain `reconcileAfterCrash: false` until connector-native batch proof is implemented and tested. A reconcile-capable test connector is sufficient to prove the transport-neutral protocol without making false production claims.

## Security and data isolation

- `pendingBatch` is durable metadata and must pass `safeDurableClone()`.
- Raw source rows, transformed rows, resolved credentials, native stack traces, connection strings, and auth material are forbidden.
- Reconciliation results are reduced to bounded acknowledgement evidence before persistence.
- Recovery events use normalized public errors and redacted details.

## Acceptance criteria

1. A pending batch is persisted before target mutation and cleared only by committed checkpoint or proven non-commit recovery.
2. Connector validation requires `reconcileTargetCommit()` whenever `reconcileAfterCrash` is advertised.
3. Crash/takeover with a proven `COMMITTED` result advances exactly one checkpoint without replaying the target mutation.
4. Proven `NOT_COMMITTED` clears pending state and permits replay from the prior committed cursor.
5. `UNKNOWN`, malformed reconciliation, unsupported connectors, and missing pending intent fail closed into `RECOVERY_REQUIRED`.
6. Secret-bearing reconciliation errors do not appear in durable job/recovery metadata.
7. Existing browser/WebMCP behavior remains unchanged.
8. Full tests, build, benchmark, dependency audit, and static security gate remain green before the increment is considered complete.
