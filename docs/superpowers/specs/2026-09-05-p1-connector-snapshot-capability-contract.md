# P1 Connector Snapshot and Capability Contract

Date: 2026-09-05
Status: design validation only; parent written architecture review still pending

## Purpose

This document closes a correctness gap between SPOOL's current connector scaffold and the durable runner/recovery design. It does not authorize implementation.

The current connector manifest exposes coarse boolean capabilities such as `streaming`, `transactions`, `checksum`, and `pagination`. Those flags are insufficient for a crash-resumable migration runner because they do not answer four questions the runner must know before execution:

1. Is a source read bound to a stable snapshot or only to a live resource?
2. Is the read order deterministic across batches and process restarts?
3. Can a target commit be unambiguously reconciled after the process dies before checkpoint persistence?
4. What level of verification can the connector truthfully prove rather than merely observe?

Until those guarantees are explicit, the runner can accidentally overstate resumability or verification strength.

## Current evidence

### Generic contract

`src/connectors/contract.js` validates only boolean feature flags. It does not express snapshot mode, cursor stability, ordering, commit identity, reconciliation, or verification strength.

### Filesystem connector

`src/connectors/filesystem.js` currently:

- advertises streaming, checksum, and pagination;
- uses a row-offset cursor;
- computes discovery identity from physical file SHA-256;
- does not bind each cursor to the discovered file identity;
- may therefore resume against a changed file if the caller supplies only the offset;
- uses atomic replacement for target publication, but the returned checkpoint token is row-count-derived rather than a durable publication identity;
- verifies physical file SHA-256 and row count, but physical byte identity is not automatically cross-connector logical equivalence.

### SQLite connector

`src/connectors/sqlite.js` currently:

- advertises transactions, rollback, checksum, pagination, streaming, and upsert;
- uses keyset pagination only for a single integer primary key;
- otherwise falls back to `LIMIT/OFFSET` without an `ORDER BY` in the read path;
- computes discovery/checksum using a separately ordered full-table materialization;
- does not hold or name a source snapshot across discovery, read, restart, and verification;
- returns a target checkpoint token derived from resource name and row count rather than a database commit identity;
- cannot therefore prove whether a commit succeeded when the daemon crashes after `COMMIT` but before durable checkpoint persistence.

These are acceptable limitations for the current scaffold, but they must not be represented as stronger guarantees by `spoold`.

## Required capability model

P1 should replace planning decisions based only on coarse booleans with a versioned capability profile. Booleans may remain for backward compatibility, but the runner must consume the richer profile.

Conceptual shape:

```ts
{
  source: {
    snapshot: 'none' | 'fingerprint_checked' | 'transactional_snapshot',
    ordering: 'none' | 'stable_key' | 'stable_total_order',
    resume: 'unsupported' | 'restart_only' | 'cursor_checked' | 'snapshot_cursor',
    cursorKind: 'offset' | 'keyset' | 'opaque' | null
  },
  target: {
    atomicity: 'none' | 'resource_replace' | 'transaction',
    commitEvidence: 'none' | 'postcondition' | 'content_identity' | 'native_commit_id',
    reconcileAfterCrash: false | true,
    idempotency: 'none' | 'batch_key' | 'upsert_key' | 'resource_replace'
  },
  verification: {
    logicalCount: false | true,
    schema: false | true,
    keyCoverage: false | true,
    sampleHash: false | true,
    logicalDatasetHash: false | true,
    physicalArtifactHash: false | true,
    maxStrength: 'BASIC' | 'STANDARD' | 'STRONG'
  }
}
```

Exact names may change during implementation, but the semantics below are required.

## Source snapshot guarantees

### `none`

The connector cannot prove that discovery/read/resume observe the same source state. Jobs using this mode are not checkpoint-resumable across process restart. They may still run from start to finish if policy allows.

### `fingerprint_checked`

The connector can compute a stable source fingerprint and re-check it before every resumed read segment. A cursor is valid only when bound to that fingerprint.

A resume token must include or reference:

- connector identity/version;
- resource identity;
- snapshot/fingerprint identity;
- ordering contract identity;
- cursor value.

If the fingerprint changes, resume fails closed with source drift and requires re-plan/restart.

### `transactional_snapshot`

The connector can name or retain a database-native snapshot with semantics strong enough to guarantee repeatable traversal. P1 SQLite should not advertise this across daemon restart unless the implementation can actually preserve such a snapshot boundary.

## Ordering guarantees

### `none`

No durable cursor is legal.

### `stable_key`

Rows are traversed monotonically using an immutable or snapshot-stable key. Composite keys are valid only if the connector implements deterministic tuple ordering and serializes the complete key in the cursor.

### `stable_total_order`

The connector defines a total order over every logical row in the frozen snapshot. Offset pagination is legal only when that same total order is explicitly applied to every page.

The discovery checksum order and read order must be the same logical ordering contract. Separate order definitions are not sufficient.

## Cursor requirements

Every resumable cursor must be self-validating or be validated against durable job metadata. It must fail closed when any of the following differs:

- connector type/version compatibility class;
- source resource identity;
- source snapshot/fingerprint;
- logical schema revision;
- ordering contract revision;
- plan revision.

A bare `{offset}` is not a durable restart cursor.

## Target commit guarantees

The runner must distinguish acknowledgement from recoverability.

### Resource replacement

For filesystem replace mode, recovery should bind publication to content identity plus destination identity. After a crash, SPOOL may reconcile by checking whether the destination contains the exact expected logical/physical artifact for the batch/job boundary.

A row-count-only token is insufficient because unrelated content can have the same count.

### SQLite transaction

A successful `COMMIT` is durable mutation acknowledgement, but P1 SQLite currently exposes no native commit identifier. Therefore recovery requires one of:

1. deterministic batch idempotency plus postcondition verification; or
2. a SPOOL-owned batch ledger written in the same transaction as target mutations; or
3. a connector-specific equivalent that can prove whether the exact batch was committed.

The runner must not infer commit success from target row count alone.

## Idempotency contract

Each target write strategy must declare how replay is made safe:

- `none`: retry after uncertain commit is forbidden;
- `resource_replace`: deterministic full-resource publication can be replayed if destination identity and expected content are fixed;
- `upsert_key`: replay is safe only when the plan proves the key and update semantics are deterministic;
- `batch_key`: the target transaction records a unique immutable batch identity atomically with mutation.

A strategy may advertise `reconcileAfterCrash: true` only when one of these mechanisms is implemented and tested.

## Verification capability negotiation

Connector `verify()` output is evidence, not proof by itself. The runner chooses verification policy only from capabilities the connector can truthfully satisfy.

### BASIC

At minimum:

- target reachable;
- expected terminal resource exists;
- processed/accepted/rejected accounting is internally consistent;
- target observation such as row count is available when promised.

### STANDARD

Adds deterministic schema/key/count assertions and a snapshot-bound deterministic sample or partition evidence.

### STRONG

Requires a source/transformed logical identity and target logical identity that are directly comparable under the canonical logical-row contract, or equally strong connector-native evidence.

A physical file SHA-256 alone is not STRONG cross-connector verification. A checksum merely computed successfully must not be reported as a passing equivalence assertion unless compared with an expected identity.

## P1 truthful capability profile

Before implementation changes, the existing connectors should be treated conservatively:

### Filesystem source

- snapshot: `fingerprint_checked` only after cursors are bound to file identity; before that, restart resume must be treated as unsupported;
- ordering: format-defined row order;
- resume: not durable until fingerprint binding exists;
- verification: physical artifact hash + row count, with logical STRONG verification pending canonical streaming logical hashing.

### Filesystem target

- atomicity: `resource_replace` for replace mode;
- reconciliation: possible only after expected content identity is persisted before publication;
- append must not inherit replace-mode crash guarantees automatically.

### SQLite source

- snapshot: `none` across process restart in the current implementation;
- ordering: `stable_key` only for the single integer-PK keyset path;
- fallback pagination is not resumable until it uses the same deterministic total order as checksum/discovery;
- STRONG verification pending bounded-memory canonical logical hashing and snapshot binding.

### SQLite target

- atomicity: `transaction`;
- rollback: only before commit;
- uncertain post-commit recovery: unsupported until exact batch commit reconciliation exists;
- upsert replay safety depends on deterministic key/update semantics and must be declared per plan, not inferred from the connector-wide `upsert: true` flag.

## Planner rules

The planner must fail closed rather than silently downgrade guarantees.

1. A requested resumable job may only use a source profile that supports restart-safe resume.
2. A destructive target strategy may not run if uncertain-commit recovery is required but unsupported.
3. A requested STRONG verification policy may only be selected when both sides can produce comparable evidence.
4. If a connector only supports BASIC or STANDARD verification, the plan and approval surface must say so explicitly.
5. Capability negotiation is frozen into the immutable plan revision so a connector upgrade cannot silently change execution semantics mid-job.
6. Resume must revalidate connector compatibility and capability profile against the frozen plan.

## Required tests after parent-spec approval

Implementation must be test-first and include at least:

1. filesystem cursor rejected after source file fingerprint changes;
2. filesystem cursor accepted when fingerprint and ordering identity match;
3. SQLite fallback pagination produces deterministic total ordering before it is marked resumable;
4. SQLite keyset cursor rejects key/schema/snapshot mismatch;
5. planner rejects restart-resumable mode for a connector advertising `snapshot: none`;
6. planner rejects STRONG verification when only physical artifact checksum exists;
7. uncertain SQLite post-commit failure does not blindly replay a non-idempotent batch;
8. replay-safe target strategy proves the exact batch identity before checkpoint advancement;
9. capability profile is frozen into plan hash/revision;
10. connector upgrade with incompatible capability revision blocks resume;
11. legacy boolean manifests remain readable during the compatibility transition but are mapped to conservative guarantees;
12. existing browser/WebMCP tests remain unchanged and green.

## Sequencing impact

This contract does not change the approved implementation order. It refines Increment A and the connector layer:

1. runtime-neutral job/receipt/isolation contracts;
2. versioned connector capability and snapshot contract;
3. transactional JobStore and recovery/fencing;
4. source-to-target runner using only negotiated guarantees;
5. authorized command service;
6. CLI/MCP stdio;
7. local HTTP `spoold`;
8. self-hosted/remote surfaces;
9. browser pairing.

No outward-facing daemon/API/MCP surface should be implemented before the runner can distinguish unsupported, restart-safe, and strongly verified execution paths.

## Decision

The next implementation must not treat `streaming: true`, `pagination: true`, `transactions: true`, or `checksum: true` as sufficient proof of resumability, recoverability, or verification strength. Those guarantees require explicit, versioned, plan-frozen semantics and tests.

This document remains design validation only until `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md` is explicitly approved in chat.