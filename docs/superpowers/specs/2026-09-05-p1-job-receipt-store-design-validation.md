# P1 Durable Job / Checkpoint / Receipt Design Validation

Date: 2026-09-05
Status: audit/design only; implementation blocked until `2026-09-05-hybrid-local-bridge-platform-design.md` is explicitly approved in chat

## Purpose

Validate the next P1 increment before implementation: a durable job store, committed checkpoints, and immutable verification receipts that sit between the deterministic kernel/connectors and future `spoold` / CLI / API / MCP surfaces.

This document does **not** authorize architectural code changes.

## Current evidence

The P1 branch already contains a real connector contract plus filesystem and SQLite reference connectors. The latest audited head is `54f620e4785bb0fa68bc9243f177adfe537900fa` (`fix: bind sqlite resume to durable cursor and checksum`). The open draft PR remains based on `main` and is mergeable.

The written platform design still states that written-spec review is pending, so the next implementation increment must remain blocked until explicit approval of that exact spec is recorded in chat.

Production remains the existing browser/WebMCP deployment; the hybrid/local daemon branch has not been merged or deployed.

## High-impact design findings

### 1. Job completion must be evidence-driven, not loop-driven

A write loop returning successfully is insufficient. Terminal `COMPLETE` must require a persisted verification result whose checks satisfy the plan's verification policy. This needs to be enforced in the state machine, not left to callers.

Required terminal rule:

```text
EXECUTING -> VERIFYING -> COMPLETE
```

`EXECUTING -> COMPLETE` is invalid.

### 2. Checkpoints need both source and committed-target boundaries

A checkpoint must describe what has been safely consumed **and** what the target has durably acknowledged. Persisting only a source cursor can skip data after a crash if the cursor is advanced before the corresponding target commit.

Minimum checkpoint payload:

```json
{
  "jobId": "...",
  "planId": "...",
  "planRevision": 1,
  "sequence": 42,
  "source": {
    "connector": "sqlite",
    "resourceRef": "redacted",
    "snapshotIdentity": "sha256:...",
    "cursor": { "offset": 5000 }
  },
  "target": {
    "connector": "filesystem",
    "resourceRef": "redacted",
    "commitIdentity": "sha256:..."
  },
  "acceptedRows": 5000,
  "rejectedRows": 0,
  "createdAt": "..."
}
```

Checkpoint persistence occurs only after target acknowledgement.

### 3. Resume must fail closed on snapshot drift

The current SQLite connector now exposes stronger checksum/identity evidence and durable cursor semantics, which is directionally correct. The runner must bind every resumable checkpoint to the source snapshot identity and connector version used when the checkpoint was created.

Resume must be rejected if any of the following changed unexpectedly:

- source snapshot/fingerprint;
- destination identity or write policy;
- connector name/version;
- plan hash/revision;
- transformation IR/hash;
- required approval/policy revision.

A user may explicitly create a new plan for a changed source; the old checkpoint must never be silently reused.

### 4. Full-table checksum implementation has a scalability boundary

The current SQLite connector's full checksum path materializes ordered rows before hashing. That is strong evidence for correctness on bounded datasets but conflicts with the platform goal that large migrations need not materialize fully in memory.

Before P1 is considered production-grade, verification should move toward streaming/incremental canonical hashing or connector-native snapshot evidence. This does not block the job-store data model, but it must be tracked as a connector scalability issue rather than normalized as the permanent verification primitive.

### 5. Receipt immutability needs a canonical serialization contract

Receipts should be content-addressed and append-only. The receipt ID should derive from a canonical serialization of all non-volatile receipt fields so equivalent evidence produces a stable hash and post-hoc mutation is detectable.

Recommended split:

- `receiptId = sha256(canonicalReceiptBody)`
- storage metadata such as local file path is outside the hashed body;
- no credentials or raw row payloads enter the body;
- redaction happens before canonicalization and hashing.

### 6. Credential isolation must be structural

The job store should persist `connectionRef` / `secretRef` handles, never resolved credential material. A connector receives resolved secrets only inside a short-lived execution context. Job/receipt serialization should reject fields matching secret-bearing runtime types rather than relying only on redaction after serialization.

### 7. One command service must own state transitions

Future CLI/API/MCP/WebMCP interfaces must call the same command service. They must not mutate jobs directly. This prevents interface-specific semantics and is required for deterministic backward-compatible behavior.

Recommended boundary:

```text
CLI / HTTP / MCP / WebMCP
        |
        v
  Command Service
        |
        +--> Deterministic kernel
        +--> Connector registry
        +--> JobStore
        +--> Policy / approval service
```

## Proposed durable state model

### Job states

```text
CREATED
  -> PLANNED
  -> READY
  -> RUNNING
  -> PAUSING
  -> PAUSED
  -> RUNNING
  -> VERIFYING
  -> COMPLETE

Any non-terminal execution state may transition to FAILED.
Cancellation is explicit and terminal only after in-flight target work reaches a known committed/rolled-back boundary.
```

The implementation should use an explicit transition table and reject unknown/illegal transitions.

### Stored records

#### Job

- `jobId`
- immutable `planId`, `planRevision`, `planHash`
- current state + state version
- redacted source/target refs
- connector names/versions
- policy/approval references
- created/started/updated/finished timestamps
- latest durable checkpoint sequence
- terminal error classification when present

#### Checkpoint

Append-only logical records keyed by `(jobId, sequence)` containing:

- source snapshot identity;
- source cursor;
- target commit/ack identity;
- processed/accepted/rejected counts;
- plan and connector identities;
- timestamp.

#### Verification

- verification policy identity;
- each check name/status/evidence;
- overall pass/fail;
- source/target identities re-read at verification time;
- count/hash/key-coverage evidence;
- verifier/tool version.

#### Receipt

Immutable terminal evidence containing:

- tool/runtime version;
- job/plan identity;
- connector identities;
- redacted source/target identities;
- source snapshot evidence;
- final committed checkpoint identity;
- processed/accepted/rejected counts;
- verification result and evidence;
- approvals/policy events;
- terminal status/error classification;
- canonical hash / `receiptId`.

## Storage choice for P1

Use SQLite for the daemon's first durable metadata store.

Reasons:

- already part of the Node 22.13+ runtime direction and P1 connector proof;
- atomic transactions for job + checkpoint updates;
- crash-safe local persistence without another service;
- easy CI/self-hosted operation;
- deterministic schema migrations and integrity constraints;
- can later be abstracted behind `JobStore` without changing command semantics.

The metadata database is distinct from user source/target SQLite databases.

## Required database invariants

- `jobs.job_id` primary key;
- optimistic `state_version` to prevent stale concurrent mutations;
- unique `(job_id, sequence)` checkpoints;
- receipt rows immutable after insert;
- exactly one terminal receipt per execution attempt;
- checkpoint sequence strictly monotonic per job;
- foreign keys enabled;
- state transition + checkpoint persistence occur in transactions;
- secrets/raw rows prohibited from persisted JSON envelopes;
- schema version recorded and migrated transactionally.

## Crash-safety protocol

For each batch:

1. read batch from source using last durable cursor;
2. transform/validate deterministically;
3. begin/prepare target operation according to connector strategy;
4. obtain durable target acknowledgement / transaction commit identity;
5. in the metadata store, atomically append checkpoint and update the job's latest checkpoint/counts;
6. only then proceed to the next source batch.

If the process dies between steps 4 and 5, recovery must not blindly re-run. The target connector needs idempotency/upsert semantics or a reconciliation check capable of determining whether the acknowledged batch is already durable. Where that cannot be proven, the job becomes `RECOVERY_REQUIRED` / non-auto-resumable rather than risking duplication.

## Verification / receipt gate

A job may become `COMPLETE` only when all are true:

1. execution reached end-of-source under the bound snapshot assumption;
2. all target writes are durably acknowledged;
3. final checkpoint is persisted;
4. connector-aware verification ran after the final write;
5. required checks pass;
6. receipt body is canonicalized, hashed, inserted immutably;
7. state transition to `COMPLETE` and receipt linkage are persisted transactionally.

## Tests required before implementation can be considered complete

### JobStore unit tests

- legal/illegal transition matrix;
- optimistic state-version conflict;
- checkpoint monotonicity;
- append-only receipt behavior;
- canonical receipt hash stability;
- persisted envelopes reject secrets/raw-row payloads;
- schema migration idempotence.

### Integration tests

- JSONL -> SQLite with checkpoints;
- SQLite -> JSONL with checkpoints;
- SQLite -> SQLite transaction path;
- pause/resume from committed checkpoint;
- process-kill/restart recovery at several crash points;
- source snapshot drift blocks resume;
- plan revision drift blocks resume;
- target ambiguity after commit-before-checkpoint fails closed;
- verification failure prevents `COMPLETE`;
- receipt generated only after verification pass;
- receipt contains no resolved secret values.

### Backward-compatibility gate

The existing browser release gate must remain green and browser-only behavior must not start depending on the daemon metadata store.

## Implementation decomposition after explicit approval

### Increment A — contracts and state machine

- runtime-neutral job/checkpoint/verification/receipt schemas;
- transition table;
- canonical hashing helpers;
- secret-bearing-type rejection/redaction contracts;
- tests only against in-memory/fake store interfaces initially.

### Increment B — SQLite JobStore

- schema/migrations;
- transactional CRUD;
- optimistic state versioning;
- append-only checkpoints/receipts;
- restart tests.

### Increment C — shared runner

- source -> transform/validate -> target loop;
- checkpoint-after-ack discipline;
- resume guards;
- verification gate;
- receipt creation;
- three required real connector workflows.

### Increment D — daemon command service

Only after the runner is proven:

- command service over JobStore/runner;
- no network server yet;
- parity tests for command envelopes;
- backward-compatible adapters to the deterministic kernel.

`spoold`, CLI, HTTP API, and MCP transport layers should follow only after these semantics are stable.

## Explicit non-goals for this increment

- no localhost server;
- no CSP changes;
- no browser pairing;
- no public bind;
- no network connector;
- no arbitrary SQL execution;
- no cloud control plane;
- no merge/deploy while the written architecture approval gate is unsatisfied.

## Next safe action

Wait for explicit chat approval of `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md`. Once approved, implement Increment A first with tests and no daemon/network surface, then run the full existing release gate before advancing.