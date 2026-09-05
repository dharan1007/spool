# SPOOL P1 Verification and Receipt Evidence Contract

Date: 2026-09-05
Status: design/evidence increment only; architectural implementation remains gated by explicit written-spec approval
Scope: P1 verification semantics, receipt integrity, connector evidence, recovery/finalization, data/credential isolation

## 1. Gate and purpose

The parent architecture spec at `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md` still records `Status: design approved in chat; written-spec review pending`.

This document does not authorize implementation. It defines the evidence contract that must be satisfied before a daemon job can truthfully become `COMPLETE` and before a receipt can be treated as durable proof of what SPOOL executed.

The core design question is:

> What exact evidence is sufficient to distinguish “the write loop returned” from “the intended source-to-target operation committed, was verified against the intended identities/revision, and produced an immutable, non-secret receipt that can be independently checked later?”

## 2. Current implementation evidence

The current branch already has useful primitives:

- `src/daemon/receipt.js` creates content-addressed receipts using canonical JSON + SHA-256;
- receipt counts enforce `acceptedRows + rejectedRows === processedRows`;
- receipt identity binds `jobId`, `planId`, `planRevision`, source/target references, counts, verification payload, connector metadata, policy events, timing, and runtime metadata;
- the SQLite connector returns row-count, primary-key-coverage, full-checksum, and sample-hash evidence;
- the filesystem connector returns target row count and file SHA-256;
- both real reference connectors expose deterministic target verification primitives.

These are strong scaffolding, but they are not yet sufficient as the authoritative completion contract.

## 3. Findings that must be closed before runtime implementation

### 3.1 Receipt creation currently requires an already-terminal job

`createReceipt()` accepts only `COMPLETE`, `FAILED`, or `ABORTED` jobs. The required recovery sequence established by the durability audits is stronger:

```text
execute target mutation
-> durable checkpoint/reconciliation
-> verify
-> persist immutable receipt
-> atomically link receipt to job terminal state
-> expose COMPLETE
```

Therefore success receipt construction must not depend on a job already being externally observable as `COMPLETE`. The durable store needs an internal finalization state/transaction so receipt persistence and terminal linkage are ordered safely.

### 3.2 Receipt hashing is deterministic but not yet a versioned interoperability contract

`canonicalJson()` recursively sorts object keys and hashes JSON text. That is deterministic for the current JavaScript value domain, but P1 needs the canonicalization rules to be explicitly versioned because receipts may be exported, checked by CLI/MCP clients, or verified across future runtimes.

The receipt must identify both:

- `receiptSchemaVersion`;
- `canonicalizationVersion`.

A future canonicalization change must not silently change the identifier of an existing receipt.

### 3.3 Connector verification currently mixes observation and assertion

SQLite currently emits checks such as `full_checksum` and `sample_hash` with `ok: true` because those values were computed successfully. That means “we observed a checksum” can look like “the checksum matched an expected value.” Filesystem verification has the same distinction for SHA-256.

P1 should separate:

- **evidence observations** — values measured from a source or target;
- **assertions** — comparisons against an expected invariant;
- **policy outcome** — whether the configured verification policy is satisfied.

A computed digest is useful evidence, but it is not itself proof of source-target equivalence unless the plan specifies what it must equal or how it participates in verification.

### 3.4 SQLite full checksum is currently full materialization

SQLite `#fullChecksum()` obtains all ordered rows and hashes the resulting object. This is deterministic for bounded datasets but violates the intended bounded-memory posture for large tables.

P1 must not claim scalable streaming verification while this implementation materializes the entire verified relation. Before production-scale claims, full-table canonical hashing should be incremental/streaming or replaced by a connector-native snapshot/evidence strategy with explicitly documented strength.

### 3.5 Filesystem verification currently re-materializes parsed rows

The filesystem connector uses `readAllRows()` to calculate target count and raw-file SHA-256 for verification. File SHA-256 itself is streaming-capable at the file layer, but row-count verification currently depends on full parsing/materialization. This is acceptable for the current reference scaffold, not for an unbounded production contract.

### 3.6 A target-only digest cannot prove source-to-target semantic equality

For transformed migrations, source bytes and target bytes may legitimately differ. Verification therefore needs a canonical logical-row evidence model tied to the immutable plan revision, rather than assuming raw-byte equality across connector types.

## 4. Required verification model

Verification is a first-class phase with an explicit policy, not an incidental connector callback.

Every finalized job should have:

```text
VerificationPolicy
VerificationEvidence[]
VerificationAssertion[]
VerificationOutcome
```

Conceptual shape:

```ts
interface VerificationOutcome {
  schemaVersion: 1;
  policyId: string;
  policyHash: string;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  strength: 'BASIC' | 'STANDARD' | 'STRONG';
  observations: VerificationEvidence[];
  assertions: VerificationAssertion[];
}
```

`COMPLETE` requires `verdict === 'PASS'` under the immutable verification policy bound into the plan revision.

`INCONCLUSIVE` must never be promoted to success merely because no explicit assertion failed.

## 5. Evidence taxonomy

P1 should use typed evidence rather than arbitrary connector JSON.

Minimum evidence types:

- `source_snapshot_identity`;
- `target_commit_identity`;
- `source_row_count`;
- `processed_row_count`;
- `accepted_row_count`;
- `rejected_row_count`;
- `target_row_count`;
- `schema_fingerprint`;
- `primary_key_coverage`;
- `canonical_sample_hash`;
- `canonical_full_hash`;
- `raw_resource_hash`;
- `connector_transaction_identity`;
- `checkpoint_identity`;
- `validation_summary`;
- `recovery_reconciliation`.

Each evidence item must declare:

```text
kind
scope
algorithm/version when applicable
value or redacted identity
observedAt
connector name/version
resource identity
```

Evidence objects must not contain raw rows or resolved credentials.

## 6. Assertion taxonomy

An assertion compares evidence against an immutable expectation.

Examples:

```text
processed_rows == source_rows_in_snapshot
accepted_rows + rejected_rows == processed_rows
target_delta == accepted_rows
primary_key_coverage == complete
schema_fingerprint == planned_target_schema_fingerprint
canonical_sample_hash == planned/transformed_expected_sample_hash
canonical_full_hash == expected_logical_hash
checkpoint_identity == final_committed_boundary
source_snapshot_identity == plan.sourceSnapshotIdentity
```

Each assertion records:

- `name`;
- `required`;
- `expected` or expected-evidence reference;
- `actual` or actual-evidence reference;
- `ok`;
- safe diagnostic detail.

Required assertions are fail-closed.

## 7. Verification strength levels

Verification strength must be explicit so a receipt cannot imply more confidence than the evidence supports.

### BASIC

Suitable only for low-risk/bounded workflows:

- intended plan/source/target identities match;
- processed/accepted/rejected arithmetic is valid;
- target commit/write acknowledgment exists;
- expected target row-count invariant passes;
- no required validation assertion failed.

### STANDARD

BASIC plus:

- schema fingerprint check;
- deterministic primary-key coverage where meaningful;
- deterministic canonical sample comparison across source transformation and target projection;
- final checkpoint/commit identity reconciliation.

This should be the default P1 completion policy for ordinary migrations.

### STRONG

STANDARD plus a complete logical-dataset equivalence mechanism, such as:

- incremental canonical full hash of the transformed accepted stream and equivalent target projection under the same canonical-row algorithm; or
- connector-native snapshot/checksum evidence whose semantics are precisely documented and equivalent for the planned operation.

A connector advertising generic `checksum: true` must not automatically qualify a job as STRONG.

## 8. Canonical logical-row hashing

Cross-connector verification needs a connector-independent logical representation.

Required rules before implementation:

1. field order comes from the immutable target contract, never runtime object insertion order;
2. null has one representation distinct from missing;
3. strings are UTF-8 and are not locale-normalized implicitly;
4. booleans have one representation;
5. integers must remain exact within the supported numeric contract;
6. decimals must use a declared canonical decimal encoding rather than binary-float display formatting;
7. timestamps require an explicit timezone/precision policy;
8. binary values require a declared encoding;
9. nested values, if supported, require versioned canonical JSON rules;
10. rows are hashed with unambiguous framing/length encoding so concatenation cannot create boundary ambiguity.

Conceptual streaming construction:

```text
H = SHA-256(
  domain_separator
  || canonicalization_version
  || target_contract_hash
  || framed(canonical_row_1)
  || framed(canonical_row_2)
  || ...
)
```

The ordering rule must also be explicit. If stable source/target ordering cannot be established, use a documented order-independent strategy rather than silently sorting an unbounded dataset in memory.

## 9. Source snapshot binding

Verification is meaningless if the source changed between planning/execution/verification without detection.

A receipt must bind the actual execution to source snapshot evidence appropriate to the connector:

- filesystem: file identity/hash + size/mtime where useful, with hash authoritative for content;
- SQLite: schema identity plus a snapshot/evidence strategy appropriate to the transaction/read model;
- future databases: connector-native transaction/snapshot IDs where available, otherwise declared weaker evidence.

Resume must fail closed when the source identity assumptions required by the plan no longer hold.

## 10. Target commit binding

A successful receipt must identify the committed target boundary, not merely the number of rows the writer attempted.

For P1:

- SQLite: stable batch/write identity plus transaction/checkpoint evidence; do not invent a database transaction ID if SQLite does not provide one with the required semantics;
- filesystem: resulting resource identity/hash plus atomic replacement identity/evidence and stable batch identity.

The receipt should distinguish connector-provided native commit identity from SPOOL-generated idempotency/batch identity.

## 11. Receipt schema requirements

The success/failure receipt should contain only durable evidence and redacted metadata.

Minimum shape:

```text
receiptId
receiptSchemaVersion
canonicalizationVersion
jobId
executionAttemptId / executionEpoch
planId
planRevision
planHash
terminalStatus
sourceRef (public/redacted)
targetRef (public/redacted)
sourceSnapshotIdentity
finalCheckpointIdentity
targetCommitEvidence
counts
verificationPolicyHash
verificationOutcome
connector manifests/version identities
policy/approval provenance
timing/runtime identity
recovery/finalization events required for interpretation
```

Explicitly excluded:

- raw source/target rows;
- resolved credentials/tokens;
- authorization headers;
- raw DSNs containing secrets;
- connector-native exceptions/stacks;
- secret reference values;
- arbitrary environment values.

## 12. Receipt identity and immutability

`receiptId` remains content-addressed, but the hash input must be the canonical durable body excluding the `receiptId` itself.

Required invariants:

- same durable body -> same receipt ID;
- same `(jobId, terminal attempt)` may not be overwritten with divergent content;
- a receipt row/object is append-only/immutable;
- terminal job linkage points to exactly one authoritative receipt for that terminal attempt;
- repeated finalization with identical evidence is idempotent;
- repeated finalization with divergent evidence fails and creates recovery/incident evidence rather than replacing the original receipt.

## 13. Success finalization protocol

Required conceptual ordering:

```text
1. runner reaches end of accepted source stream
2. target final write/commit acknowledged or reconciled
3. durable checkpoint records final committed boundary
4. verification observations are gathered
5. verification assertions evaluate immutable policy
6. verdict must equal PASS
7. immutable receipt body is canonicalized + hashed
8. receipt is inserted immutably
9. receipt linkage + terminal COMPLETE state commit atomically
10. public COMPLETE becomes observable
```

A crash at steps 7-9 must be recoverable without duplicate mutation or divergent receipt creation.

## 14. Failure and aborted receipts

A non-success receipt is still useful evidence, but it must not masquerade as verified completion.

`FAILED`, `ABORTED`, and `RECOVERY_REQUIRED` evidence should record:

- last known durable checkpoint;
- whether target commit status is known/unknown;
- safe normalized error category/code;
- completed verification observations, if any;
- why verification could not pass;
- recovery classification;
- policy/approval provenance relevant to the attempt.

An ambiguous commit must never be represented as an ordinary `FAILED` receipt whose retryability implies it is safe to replay.

## 15. Public inspection and export

The command service should expose:

- receipt summary by default;
- full redacted receipt on explicit receipt read;
- optional verification-evidence detail when authorized;
- no raw-row inclusion in generic receipt inspection.

Receipt export should support canonical JSON so a user/CI system can recompute `receiptId` independently.

A later signed-attestation feature may sign a receipt ID/body, but signing is not required for P1 and must not be confused with verification correctness. A cryptographic signature proves origin/integrity of an assertion, not that the assertion itself was sufficiently verified.

## 16. Connector contract implications

The connector interface should eventually distinguish:

```text
observeVerificationEvidence(...)
```

from policy assertion/evaluation owned by the shared runner/core.

Connector-specific code is best positioned to observe resource-native facts; the shared verification layer is best positioned to decide whether those facts satisfy the immutable migration plan.

This prevents one connector from defining `ok` more weakly than another and still producing a platform-level `COMPLETE` state.

## 17. Performance and bounded-memory requirements

Before P1 is called production-grade for large datasets:

- source transformation verification must be incremental;
- SQLite full logical hashing must not call `.all()` over the complete relation;
- filesystem row counting must not require complete row-array materialization;
- samples must be deterministically selected with bounded memory;
- verification must expose bytes/rows processed and may use bounded batches;
- cancellation must not leave a receipt claiming a completed verification pass.

Reference-connector tests may use small fixtures, but at least one bounded-memory test should use a dataset large enough to catch accidental whole-dataset collection.

## 18. Required fault and mutation tests after approval

Before verification/receipt code is considered complete, tests should prove:

1. write loop success + failed required assertion cannot reach COMPLETE;
2. observed checksum without an expected comparison cannot satisfy a required equivalence assertion;
3. source snapshot drift causes FAIL/RECOVERY_REQUIRED as appropriate;
4. target row-count mismatch fails verification;
5. schema fingerprint mismatch fails verification;
6. primary-key duplicate/missing coverage fails when required;
7. canonical sample hash changes on transformed-value corruption;
8. canonical full hash changes on any tested row corruption;
9. crash after verification before receipt insert resumes idempotently;
10. crash after receipt insert before terminal linkage reuses the identical receipt;
11. divergent second receipt for the same terminal attempt is rejected;
12. secret values cannot enter receipt serialization even under adversarial connector error/details input;
13. raw rows cannot enter receipt durable types;
14. exported canonical receipt recomputes the same receipt ID;
15. large verification fixtures remain within the chosen bounded-memory envelope.

Mutation tests should deliberately weaken the finalization ordering and individual required assertions to prove the suite turns red.

## 19. P1 acceptance rule

A P1 job may report `COMPLETE` only when all of the following are true:

```text
immutable plan identity matched
AND execution ownership/checkpoint state is valid
AND target mutation is committed/reconciled
AND required verification policy evaluates PASS
AND immutable receipt is durably stored
AND terminal job -> receipt linkage is durable
```

No single connector `ok: true`, successful write-loop return, target row count, checksum observation, or receipt hash is sufficient by itself.

## 20. Impact on implementation sequence

This audit does not change the existing dependency order. It sharpens Increment A-C and D:

- Increment A: define typed verification evidence/assertion/outcome and versioned receipt/canonicalization contracts;
- Increment B: enforce immutable receipt insertion and atomic terminal linkage in the transactional store;
- Increment C: make finalization/recovery idempotent across crashes and ambiguous commits;
- Increment D: make the shared runner gather connector observations and evaluate the platform verification policy before success.

CLI, MCP, HTTP, self-hosted, and paired WebMCP remain downstream consumers of the same receipt/public DTO and must not implement their own weaker completion rules.

## 21. Next action

Until the parent written spec is explicitly approved in chat, no verification/runtime implementation should be added.

After approval, fold these invariants into Increment A contract tests first, then the transactional JobStore/finalization protocol. Do not expose `spoold` or any network-facing execution surface before the receipt/finalization boundary is transactionally safe.
