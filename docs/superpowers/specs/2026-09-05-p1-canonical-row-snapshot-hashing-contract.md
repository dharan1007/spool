# SPOOL P1 Canonical Row, Snapshot, and Hashing Contract

Date: 2026-09-05
Status: design validation only; implementation remains blocked until `2026-09-05-hybrid-local-bridge-platform-design.md` is explicitly approved in chat

## Purpose

This document closes the remaining semantic gap between connector observations, resumable execution, and verification receipts. SPOOL cannot safely claim that a source snapshot, transformed batch, or target state is equivalent across filesystem and SQLite connectors until all participants use the same versioned logical-row representation, ordering rules, snapshot identity rules, and bounded-memory digest semantics.

This is not an implementation plan and introduces no runtime code.

## Current evidence

The current P1 scaffold is directionally correct but does not yet provide a connector-neutral evidence model:

- `src/platform/canonical-json.js` sorts object keys recursively and hashes the resulting JSON with SHA-256. This is deterministic for ordinary JSON-compatible values, but it has no explicit logical type tags, schema binding, timestamp/decimal/bytes semantics, missing-vs-null distinction, or dataset framing/version.
- SQLite full verification currently materializes every ordered row and hashes one JSON object containing the resource, columns, primary key, and rows. This is deterministic for bounded tables but is not bounded-memory and its result is coupled to SQLite's runtime value projection.
- SQLite uses primary-key ordering where available and otherwise orders by every discovered column for full checksum, but its streaming read fallback uses `LIMIT/OFFSET` without an `ORDER BY`. Therefore the checksum traversal and resumable read traversal do not currently share one ordering contract.
- Filesystem discovery and verification parse the complete resource to infer/count rows while separately hashing physical file bytes. A physical file SHA proves byte identity, not logical-row equivalence with SQLite or another file serialization.
- Filesystem resume cursors are row offsets. Without binding the cursor to a frozen source identity, a changed file can make the same offset refer to different logical rows.

These are acceptable scaffold limitations but must be resolved before durable cross-connector execution or `COMPLETE` receipts are treated as production evidence.

## Decision 1 — Separate physical identity from logical dataset identity

Every source/target observation has two independent identities.

### Physical resource identity

Connector-native evidence that the concrete resource did not change unexpectedly.

Examples:

- filesystem: content SHA-256 plus size and, when useful, stat metadata;
- SQLite: database/resource identity plus snapshot/transaction evidence available to that connector;
- later databases: transaction snapshot identifiers, LSN/binlog coordinates, ETag/version IDs, commit IDs, or other native evidence.

Physical identity is connector-specific and may not be comparable across connectors.

### Logical dataset identity

A connector-neutral digest of the projected logical schema and canonical logical rows under a declared ordering contract.

Logical identity is what SPOOL uses for cross-connector equivalence claims.

A receipt must never label a physical byte hash as proof of logical source-to-target equality.

## Decision 2 — Freeze a logical schema before strong verification

Strong verification operates against an immutable `LogicalSchemaV1` bound into the plan revision.

Each field contains at minimum:

- stable field name;
- logical type;
- nullability;
- ordinal position;
- optional precision/scale or temporal precision where the logical type requires it.

Connectors map physical values into this schema before canonicalization. If a value cannot be represented without an unapproved lossy conversion, execution or strong verification fails closed rather than silently coercing it.

Field ordering is schema ordinal order. JavaScript object insertion order and vendor result-object key order are not verification semantics.

## Decision 3 — Canonical logical scalar domain

P1 should keep the logical value domain deliberately small and explicit.

Supported scalar classes:

- `null`;
- `boolean`;
- `integer` — signed integer represented losslessly; values beyond JavaScript safe integer range require a lossless representation rather than `Number`;
- `decimal` — canonical sign/coefficient/scale representation, not binary floating-point text formatting;
- `float64` — IEEE-754 binary64 value with explicit handling rules below;
- `string` — exact Unicode scalar sequence as supplied after connector decoding;
- `bytes` — exact octets;
- `date` — calendar date without timezone;
- `timestamp` — absolute instant plus declared precision, normalized to UTC for canonical encoding;
- `local_datetime` — wall-clock datetime without timezone, kept distinct from an instant;
- `json` — canonical structured value recursively encoded by this same logical value contract.

P1 connectors may support only a subset. A manifest/discovery result must not claim a logical type the connector cannot encode and round-trip safely.

### Important normalization rules

- Do not apply Unicode NFC/NFKC normalization implicitly. Unicode normalization changes data semantics for some sources; exact decoded string content is preserved unless the approved transform explicitly normalizes it.
- Distinguish a missing field from a present field whose value is `null` at ingestion. Once a fixed relational target schema is projected, any missing-field mapping must be explicit in the plan.
- Normalize `-0` and `+0` only according to the declared logical type. For integer/decimal they are the same canonical zero. For `float64`, preserve the IEEE distinction only if SPOOL elects to make float bit identity part of the contract; otherwise reject negative-zero-sensitive strong comparison. P1 recommendation: canonicalize both to zero and document that policy.
- `NaN`, `+Infinity`, and `-Infinity` are not valid JSON numbers and frequently have incompatible target semantics. P1 recommendation: reject them for cross-connector strong verification unless both source and target explicitly advertise a matching non-finite-float capability.
- Decimal values must never be routed through JavaScript `Number` for canonical hashing.
- Timestamp hashing must not depend on locale, host timezone, or default string formatting.

## Decision 4 — Use a versioned framed encoding, not ad-hoc JSON stringification, for dataset evidence

`canonical-json.js` remains suitable for existing plan/config hashing where its current domain is already constrained and backward compatibility matters. Dataset evidence should use a distinct, explicitly versioned encoding such as `spool-logical-row-v1`.

The encoding must be:

- self-delimiting or length-prefixed;
- domain-separated by object kind and version;
- schema-bound;
- type-tagged for every scalar;
- deterministic across Node processes and connectors;
- streamable without retaining the full dataset;
- independent of object-key enumeration order.

Conceptually, each row digest receives:

1. protocol/version domain tag;
2. logical schema hash;
3. row ordinal or stable ordering-key representation;
4. for each field in schema order: field ordinal, type tag, null/missing marker, length, canonical bytes.

This avoids ambiguous concatenation and makes future encoding changes safely versioned.

P1 should continue using SHA-256 because it is already the repository's deterministic digest primitive and is sufficient for integrity evidence. Changing the hash algorithm is not necessary to solve the semantic problem.

## Decision 5 — One ordering contract must govern read, resume, hashing, and sampling

For any job that claims restart-safe deterministic execution, SPOOL freezes an `OrderingContractV1` into the plan.

Priority:

1. explicit user/planner ordering key validated as stable and unique enough for the selected strategy;
2. connector-declared primary/unique key;
3. otherwise no strong resumable ordering is available.

For P1 SQLite:

- single integer primary-key keyset pagination is acceptable as the strongest currently implemented path;
- composite/stable keys should eventually use lexicographic keyset pagination rather than offset pagination;
- `LIMIT/OFFSET` without `ORDER BY` must not back a deterministic resume or strong snapshot claim;
- ordering by every column may be useful for a one-shot checksum but does not by itself make offset resume safe under concurrent mutation.

For filesystem CSV/JSONL:

- physical row order is the deterministic order;
- row-offset resume is valid only while the physical source identity is unchanged;
- JSON arrays preserve array order;
- unordered JSON object/map resources are not silently treated as ordered row sets.

If no valid ordering contract exists, SPOOL may still run a non-resumable/bounded job if policy permits, but it must downgrade verification/recovery capabilities and make that limitation explicit before execution.

## Decision 6 — Bind every durable cursor to a source snapshot contract

A durable checkpoint is not just a cursor.

Minimum source side:

- connector/version;
- resource identity;
- logical schema hash;
- physical source identity or connector-native snapshot token;
- ordering contract hash;
- cursor value;
- last committed batch identity;
- plan revision/hash.

On resume, SPOOL revalidates these assumptions before reading the next row.

If the source physical/snapshot identity changed and the connector cannot prove that the already-committed prefix is unchanged under the same ordering contract, the job transitions to `RECOVERY_REQUIRED`; it never silently continues from the old offset/key.

## Decision 7 — Define stable batch identities

Each execution batch receives a deterministic `batchId` derived from immutable execution inputs, not process timing.

Recommended inputs:

- job lineage ID;
- plan revision/hash;
- source snapshot identity hash;
- ordering contract hash;
- start cursor/key;
- end cursor/key;
- row count;
- canonical batch logical digest.

The batch ID is recorded before/with target commit evidence and then durably attached to the checkpoint. This is the reconciliation handle for the crash window where the target commit succeeds but checkpoint persistence does not.

## Decision 8 — Bounded-memory logical dataset hashing

Strong verification must not require `rows = [...allRows]`.

The required algorithmic property is O(batch-size) memory, with an optional O(log n) accumulator if a tree structure is used.

Simplest P1-compatible design:

- initialize a SHA-256 dataset hasher with domain tag + encoding version + logical schema hash + ordering-contract hash;
- stream rows in the frozen deterministic order;
- encode each row with unambiguous framing and feed it directly into the hasher;
- finalize with total row count and, if needed, terminal cursor/snapshot evidence.

A streaming linear digest is sufficient when deterministic ordered traversal is guaranteed. A Merkle structure is not required for P1 and should be added only if SPOOL later needs parallel verification/proofs over subranges.

Physical file SHA-256 can be computed concurrently as separate connector-native evidence.

## Decision 9 — Verification levels must reflect available evidence

### BASIC

Useful operational checks but no source-target equality claim.

Examples: target accessible, expected count if known, constraints/PK coverage.

### STANDARD

BASIC plus deterministic bounded samples and source/target metadata checks under a known plan revision.

Sampling must be derived deterministically from stable keys or digest-derived positions, not “first 100 rows” alone.

### STRONG

Requires all of:

- frozen logical schema;
- compatible source/target logical projections;
- stable ordering contract or another approved exact multiset-equivalence method;
- source snapshot/physical identity evidence sufficient for the run;
- complete streaming logical digest over the expected transformed source state;
- complete streaming logical digest over the target state;
- equal row counts and equal logical digests;
- no unresolved validation rejects unless the plan's expected result explicitly incorporates them;
- matching plan/transform revision;
- terminal target commit evidence where available.

If any prerequisite is unavailable, result is `INCONCLUSIVE` or the configured lower verification level. It is not promoted to `PASS` merely because a hash was successfully computed.

## Decision 10 — Transformed-source expectation is the comparison baseline

For migrations with transforms, the target is not compared to raw source rows. The runner computes verification evidence over the deterministic post-transform/post-validation accepted row stream that the approved plan says should exist at the destination.

The receipt therefore distinguishes:

- raw source snapshot identity;
- transform/plan identity;
- accepted logical output digest/count;
- rejected/quarantined count and evidence;
- observed target logical digest/count.

This prevents a receipt from confusing “source equals target” with “approved transformed source result equals target.”

## Decision 11 — Sampling is diagnostic evidence, not exact proof

A sample hash can help localize drift but cannot establish whole-dataset equality.

P1 deterministic sampling should be based on stable ordering keys and the plan/snapshot identity so source and target choose the same rows. “First N” may be retained as an additional debug observation but must not be labeled strong verification.

## Decision 12 — Receipt evidence is immutable and self-describing

A receipt's verification section records at minimum:

- evidence contract version;
- logical row encoding version;
- hash algorithm;
- logical schema hash;
- ordering contract hash;
- physical source identity evidence (redacted where necessary);
- source snapshot token/fingerprint class;
- expected transformed row count/digest;
- observed target row count/digest;
- deterministic sample policy and evidence if used;
- connector-native target commit/checkpoint evidence;
- verification strength requested and actually achieved;
- individual assertions with `PASS`/`FAIL`/`INCONCLUSIVE`;
- terminal aggregate result.

The immutable receipt contains evidence, not secrets or raw dataset rows.

## Connector-specific P1 implications

### SQLite

Before production-grade strong verification/resume:

1. make read traversal use the same deterministic ordering contract as hashing;
2. reject/downgrade resumable operation when no stable ordering key exists instead of using unordered offset pagination;
3. stream canonical rows into the digest rather than `statement.all()` for the complete table;
4. map SQLite runtime values through the frozen logical schema before hashing;
5. freeze/validate schema and source snapshot assumptions across the run;
6. ensure comparison hashes represent expected transformed rows and observed target rows, not merely independently successful checksums.

### Filesystem

Before production-grade strong verification/resume:

1. bind row-offset cursors to a physical file identity;
2. avoid full row materialization solely to count/verify large resources;
3. retain physical byte SHA as connector-native evidence but add logical-row digest for cross-connector verification;
4. freeze parser/schema semantics so the same file is not reinterpreted differently on resume;
5. stream output writes/verification for large datasets instead of collecting every incoming/existing row when the selected write mode permits it.

## Failure semantics

The following must fail closed or downgrade explicitly:

- source identity changed between checkpoint and resume;
- schema hash changed;
- ordering contract changed;
- connector version change invalidates cursor/snapshot semantics;
- non-finite float encountered without matching capability;
- lossy decimal/integer conversion required;
- timezone/temporal interpretation is ambiguous;
- no deterministic ordering exists for a requested restart-safe strategy;
- expected transformed digest cannot be produced;
- target digest cannot be compared under the same logical schema;
- verification traversal sees drift while the target is changing.

None of these conditions can produce a strong `PASS` receipt.

## Required contract tests after written-spec approval

These tests belong in Increment A before outward-facing daemon transports are added.

### Canonical scalar/row vectors

- key/object insertion order does not affect row digest;
- field ordinal does affect schema/row identity where it changes logical schema;
- missing and null are distinct until projection resolves them;
- large integers remain lossless;
- decimal textual spellings representing the same approved decimal normalize identically;
- timestamps are timezone-independent and precision-bound;
- local datetime remains distinct from timestamp;
- byte sequences hash independently of text encoding;
- Unicode is preserved without implicit normalization;
- float negative-zero policy is pinned;
- NaN/infinity rejection/capability behavior is pinned.

### Cross-connector fixtures

The same frozen logical dataset represented as:

- CSV/JSONL -> logical rows;
- JSON array -> logical rows;
- SQLite table -> logical rows;

must produce the same logical dataset digest after explicit schema projection, while their physical hashes may differ.

### Streaming/bounds

- digest a dataset substantially larger than one normal batch while asserting memory remains bounded by implementation design;
- digest is invariant to connector batch boundaries;
- digest changes on row change, row-order change under an ordered contract, schema change, or type change.

### Resume/drift

- unchanged file + durable row cursor resumes to the same digest;
- changed file with old cursor yields `RECOVERY_REQUIRED`;
- SQLite stable-key resume produces no duplicate/skip across process restart;
- unordered/offset-only SQLite path cannot claim restart-safe strong mode;
- stale execution epoch cannot persist a checkpoint/digest from an older runner.

### Verification/receipt

- successful checksum computation without expected comparison remains observation, not assertion pass;
- full transformed-source and target digest equality yields strong `PASS` only when all prerequisites hold;
- mismatched digest yields `FAIL`;
- unavailable snapshot/order evidence yields `INCONCLUSIVE`, not `PASS`;
- receipts contain hashes/identities but no raw rows or resolved secrets.

## Sequencing consequence

This contract belongs before transactional JobStore/runner completion because checkpoint rows, stable batch IDs, recovery reconciliation, and verification receipts all need the same snapshot/ordering/digest identities. The safe implementation sequence remains:

1. runtime/isolation contracts, including canonical logical row/snapshot/hash contracts;
2. transactional JobStore with state-version and execution-epoch fencing;
3. crash recovery and target-commit/checkpoint reconciliation;
4. real streaming source-to-target runner using the deterministic kernel;
5. authorized command service;
6. CLI/MCP stdio;
7. local `spoold` HTTP;
8. remote/self-hosted transport hardening and browser pairing.

## Acceptance criterion for this design increment

The next implementation plan is not ready to claim production-grade verification until it can answer, for every resumable/verified job:

> Which exact source snapshot, under which frozen schema and ordering contract, produced which canonical transformed logical rows, which target commit contains them, and which bounded-memory evidence proves the comparison?

If any element is missing, SPOOL must surface that limitation rather than manufacturing certainty.
