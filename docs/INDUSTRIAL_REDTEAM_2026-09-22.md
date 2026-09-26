# SPOOL Industrial Red-Team Audit — 2026-09-22

## Scope

Audit target: `dharan1007/spool` branch `feat/industrial-postgres-qualification` at
`1935163783c07390a93a09d4c25c21cc1450ebb4`.

Audit branch: `audit/industrial-redteam-20260922`.
Audit PR: #72, based on the industrial branch and intentionally not targeted at `main`.

This report distinguishes:
- **confirmed code defect** — source path is sufficient to construct the failure;
- **qualification defect** — evidence harness cannot prove the claim it labels;
- **unproven risk** — a production-relevant edge case has no sufficient evidence yet;
- **infrastructure blocker** — the verification system itself did not execute.

## Verdict

**NOT INDUSTRIAL / ORGANIZATIONAL PRODUCTION READY.**

The strongest blockers are not cosmetic or documentation gaps. At least one path can undermine
the PostgreSQL CDC `COMMITTED_EXACT` guarantee, enterprise approval identity is not independently
authenticated/authorized, hard-crash qualification contains shortcuts, and the current hosted
release gate is unable to execute jobs.

The existing design has strong foundations: transaction-scoped fencing, atomic target+ledger
commit, real PostgreSQL table-lock cutover barrier, loopback daemon hardening, bounded request
bodies, secret-return leak checks, path canonicalization, signed receipts, and immutable evidence
mechanisms. Those strengths do not neutralize the blockers below.

---

## P0-1 — CONFIRMED DATA-INTEGRITY DEFECT
### Target-contract cache TOCTOU + non-exact CDC upsert effect proof

### Source facts

`src/connectors/postgres/target.js` caches a proven target contract for 10 seconds.

The cache key is only:
`database.schema.table`

It omits endpoint/connection identity.

`commitCdcTransaction()` calls `checkRepairContract()`, but a warm cache can skip a live
catalog re-read. The target preflight/contract record correctly includes enabled user triggers and
rewrite rules, but that protection is bypassed during the cache TTL after out-of-band DDL.

The CDC upsert path then executes:
`INSERT ... ON CONFLICT ... RETURNING (xmax = 0) AS inserted`

For each SQL piece, it counts returned rows, but currently rejects only when:
`inserted + updated < 1`

It does **not** prove:
`written.rowCount === piece.length`

### Reproduction constructed in audit tests

`tests/industrial-postgres-contract-race.test.js`:

1. Create a clean ordinary target table.
2. Preflight and obtain its contract ID.
3. Warm the target-contract cache through a valid CDC commit.
4. In a separate session, add a `BEFORE INSERT OR UPDATE` trigger inside the 10-second cache
   window.
5. The trigger returns `NULL` for exactly one of two incoming rows.
6. Commit a two-row CDC source transaction using the old target contract.
7. If the stale cache is trusted, PostgreSQL can return one modified row while SPOOL's current
   "at least one" check still permits the source transaction to progress to its ledger record.

PostgreSQL's documented trigger semantics permit a row-level BEFORE trigger to return NULL and
skip the operation for that row. Therefore this is not a hypothetical database behavior.

### Impact

A transaction can be represented by SPOOL as `COMMITTED_EXACT` with `rowCount=2` while the
materialized target contains only one of the two intended rows.

This breaks the central exactness guarantee and can make ledger replay preserve the wrong result.

### Required fix

1. A mutation transaction must not use TTL cache state as the correctness proof of target contract.
2. Acquire a DDL-conflicting target-table lock before the live contract proof and retain the lock
   until target mutation + ledger commit completes, or use an equivalent mechanism that closes
   the catalog-to-DML TOCTOU window.
3. If metadata caching remains for performance, include canonical endpoint/connection identity and
   principal in the key and treat the cache only as an optimization, never the mutation proof.
4. Require exact per-piece effects:
   `written.rowCount === piece.length`
   and independently reconcile inserted/updated counts with the piece size.
5. Add a concurrent-DDL fault matrix: trigger, rule, add/drop/alter column, PK/index replacement,
   RLS enablement, generated/identity changes.
6. Audit test must pass on real PostgreSQL 17 and PostgreSQL 18.

---

## P0-2 — ORGANIZATIONAL AUTHORIZATION / SEPARATION-OF-DUTIES GAP

### Source facts

`spoold` is well constrained at the transport boundary:
- loopback-only bind;
- bearer token;
- constant-time token comparison;
- Host validation;
- browser Origin allowlist;
- bounded JSON body.

However, `SpoolCommandService.approve()` and `approveRepair()` create cryptographically valid
approval envelopes inside the same execution service using `request.principal`.

The principal is caller-supplied request data. The daemon bearer token authenticates access to the
local daemon but does not establish the human/service identity represented by
`request.principal`, and there is no independent RBAC/ABAC authorizer or second-approver control
in this boundary.

### Impact

For a single-user local tool, this can be an explicit trust model.

For an organizational product, anyone possessing the daemon bearer token can reach the approval
minting path and claim an arbitrary principal string. The execution authority and approval-signing
authority are therefore not separated.

That is insufficient for enterprise change control, regulated separation-of-duties, non-repudiation,
or multi-operator attribution.

### Required fix

For organizational mode:

1. Never derive authenticated principal from request JSON.
2. Authenticate the caller through a trusted identity layer (OIDC/mTLS/workload identity/local OS
   peer credentials as appropriate).
3. Authorize effects through explicit policy (RBAC/ABAC), independently of the migration request.
4. Split approval signing authority from execution authority.
5. Support mandatory two-person approval for destructive/cutover/repair classes.
6. Record immutable approver identity, auth method, policy decision, request hash, expiry and
   revocation state.
7. Store signing keys in KMS/HSM/OS secure keystore for enterprise mode; local PEM may remain a
   documented single-user mode.
8. Add replay/revocation/key-rotation/compromised-token tests.

---

## P0-3 — QUALIFICATION DOES NOT PROVE REAL DEAD-OWNER RECOVERY

### Confirmed harness behavior

`scripts/qualify/postgres/crash-recovery.js` performs a real child-process `SIGKILL`, but then
administratively removes the dead worker lease from
`spool_internal.execution_leases` before recovery.

That bypasses the real stale-lease TTL/takeover path.

A separate cutover durable-boundary matrix labels service close/reopen as process-equivalent
restart instead of hard-killing a separate process at every durable transition.

The qualification checkpoint helper also uses a raw `writeFile(checkpointPath, JSON.stringify(...))`
rather than the production durable run/checkpoint primitive.

### Impact

A PASS does not prove:
- natural lease expiry;
- takeover timing;
- stale-owner fencing after natural expiry;
- crash during lease renewal;
- hard process death at every cutover durable boundary;
- production checkpoint durability under the same crash model.

### Required fix

1. Never DELETE/repair the lease administratively in crash qualification.
2. Use real TTL expiration and owner-B takeover.
3. Assert monotonic fence-token advance.
4. Assert owner-A cannot commit after takeover.
5. Spawn separate worker processes and `SIGKILL` them at every durable transition.
6. Add machine/power-loss class tests where feasible: abrupt VM/container termination, disk-full,
   I/O error, fsync error and database restart.
7. Qualification must use the same durable checkpoint/run-store implementation as production.

Audit test:
`tests/industrial-postgres-lease-recovery.test.js`.

---

## P0-4 — RELEASE ASSURANCE INFRASTRUCTURE IS CURRENTLY NON-FUNCTIONAL

Multiple runs on the industrial head and audit head report failure before any job step executes.

The dedicated audit workflow run also completed with:
- `runner_id: 0`
- empty runner name
- empty `steps`
- failure within seconds.

Therefore those red runs are **not** product-test failures, but they prove an independent release
readiness problem: the required hosted verification pipeline currently cannot execute.

Until the runner/account/actions condition is corrected, GitHub CI status cannot substantiate a
shipping claim.

CodeQL on a private repository may additionally depend on the repository/account's GitHub Code
Security entitlement/configuration; this must be resolved rather than treating a red CodeQL badge
as a JavaScript finding.

### Required fix

1. Restore runner allocation.
2. Require exact-head release-gate execution before merge/release.
3. Require CodeQL or an equivalent supported SAST gate.
4. Preserve raw logs and immutable artifacts.
5. Block releases when any required gate is not executed.

---

## P0-5 — `releaseGrade` SEMANTICS OVERSTATE THE EXECUTED PROFILE

The qualification harness currently derives release grading primarily from PASS + clean worktree.
A clean CI profile can therefore produce `releaseGrade=true`.

The committed evidence bundle for
`f46c0e74675506c34c4c6419479757a0054df995` is exactly such a case:

- profile: CI;
- 100,000 rows;
- 30-second CDC soak;
- largest source transaction: 10,000 rows;
- releaseGrade: true.

The report in the same evidence bundle explicitly states that 10M+ rows, long soak, fencing/HA,
backup/restore and rolling-upgrade qualification had not been run.

### Impact

The cryptographic/evidence machinery can faithfully authenticate an over-broad semantic claim.
Evidence integrity is not equivalent to evidence sufficiency.

### Required fix

Replace boolean `releaseGrade` with explicit qualification classes, for example:

- `CI_CORRECTNESS`
- `PILOT`
- `SMALL_PRODUCTION`
- `MEDIUM_PRODUCTION`
- `LARGE_PRODUCTION`
- `INDUSTRIAL`

Each class must require its own profile plus mandatory resilience/security/upgrade scenarios.
An INDUSTRIAL label must never be derivable from the CI profile.

---

## P1-1 — UNCHANGED-TOAST CDC FIDELITY IS UNPROVEN

PostgreSQL logical replication can represent an unchanged out-of-line TOAST value without sending
the full new value.

Current SPOOL normalization passes the library's `message.new` into the normalized UPDATE row;
existing tests inspected in this audit do not explicitly prove that a large unchanged toasted
column remains byte-identical after a small-column UPDATE.

Audit test:
`tests/industrial-postgres-toast.test.js`.

Required outcome:
- large incompressible payload;
- `REPLICA IDENTITY FULL`;
- change only a small non-TOAST field;
- normalized update must preserve/reconstruct the exact payload;
- target after CDC apply must hash exactly to source.

---

## P1-2 — LARGE-TRANSACTION SPILL I/O DESIGN NEEDS A REAL 1M-EVENT TEST

After spilling begins, `spillEvent()` creates, writes and closes an append stream for each spilled
event.

That preserves bounded memory but can produce extreme file-open/write/close amplification for a
very large source transaction.

The committed release-grade evidence only exercised 10,000 rows for the large-transaction scenario.

Required:
- persistent/segmented spill writer;
- 100k / 500k / 1M event transactions;
- wall time, CPU, open syscalls, bytes written, RSS, disk occupancy;
- forced crash during spill;
- WAL replay recovery;
- no descriptor leaks;
- latency budget.

---

## P1-3 — PERFORMANCE EVIDENCE IS NOT INDUSTRIAL YET

The committed CI evidence reports approximately:
- target load: 4,001 rows/s;
- bulk load: 4,758 rows/s;
- exact verification: 1,548 rows/s;
- repair: ~2 operations/s for 100 corrupt rows;
- peak RSS: ~443 MiB;
- 100k-row scale;
- 30-second CDC soak.

These numbers can be useful as CI regression baselines, but they are not sufficient industrial
capacity evidence. A latency histogram with one sample cannot establish p95/p99 behavior.

Required:
- fixed reference hardware specification;
- warm/cold runs;
- >=30 repeated samples per meaningful percentile;
- throughput vs batch-size curves;
- p50/p95/p99/p99.9;
- sustained 1h/6h/24h runs;
- 10M/100M/1B profiles actually executed before those profile names are claimed;
- CPU, RSS, GC, IOPS, WAL, network, DB wait events and queue depth;
- performance regression budgets.

---

## P1-4 — GITHUB ACTIONS SUPPLY-CHAIN HARDENING

Production workflows reference actions by mutable major tags such as:
- `actions/checkout@v7`
- `actions/setup-node@v5`
- `actions/upload-artifact@v4`
- `github/codeql-action/*@v4`

For a high-assurance release path, pin third-party/GitHub actions to reviewed full commit SHAs and
enable the repository/organization policy requiring SHA pinning.

Also add:
- SBOM generation;
- provenance/attestation for packaged artifacts;
- dependency license inventory;
- dependency review on PR;
- secret scanning/push protection;
- artifact-signing verification at install/deploy boundaries.

---

## P1-5 — RELEASE/APPROVAL KEY LIFECYCLE NEEDS ENTERPRISE MODE

Receipt signing correctly uses Ed25519 and trust-root fingerprints, but the source explicitly
documents local PEM only and no KMS/HSM claim.

`scripts/generate-release-keys.js` prints the generated private key to stdout. That is convenient
for local setup but unsuitable as the standard enterprise key-generation path because shell/CI
logs can become secret-bearing artifacts.

Required:
- KMS/HSM/secure-keystore provider interface;
- key IDs and rotation;
- old-key verification / new-key signing;
- revocation metadata;
- no private-key stdout in enterprise workflows;
- signing audit trail.

---

## P2 / HARDENING

- Add bounded request concurrency / admission control to `spoold`, not only body-size limits.
- Add per-command timeouts and cancellation propagation.
- Add metrics/tracing for queue depth, checkpoint lag, WAL lag, lease expiry, lock wait, retry
  storms, disk pressure and recovery state.
- Test process clock skew for expiry-sensitive artifacts where wall time is consumed.
- Test PostgreSQL failover/promotion and replication-slot continuity.
- Test WAL retention exhaustion and slot invalidation under sustained outage.
- Test target failover during commit and ambiguous commit outcomes.
- Test DNS/TLS certificate rotation and transient network partitions.
- Test schema drift during snapshot, CDC catch-up, final drain and cutover.
- Test backup/restore, downgrade refusal, metadata schema upgrades and rolling upgrade.
- Test multiple concurrent migrations against the same source/target and metadata schema.
- Test disk-full/ENOSPC on snapshots, SQLite state, CDC staging and evidence directories.
- Test corrupted/torn local state files and database metadata rows.
- Fuzz all public JSON command envelopes and connector refs.
- Fuzz CSV/encoding/parser boundaries and malicious identifiers.
- Run ASVS-style transport/API review even for the loopback daemon.
- Define SLOs and a supportable incident playbook before enterprise sale.

---

## Strong areas observed

The audit should not erase real engineering progress. The following are materially strong:

1. PostgreSQL target mutation + ledger are transactionally co-committed.
2. Lease fencing is checked inside the target transaction.
3. PostgreSQL cutover has a real held table-lock barrier plus an independent conflicting-lock probe.
4. CDC checkpoint-before-ack ordering and ledger replay design are structurally sensible.
5. PostgreSQL preflight rejects enabled user triggers, rewrite rules, RLS, unsupported table kinds,
   and incompatible schema features.
6. `spoold` is loopback-only and has token/Host/Origin/body controls.
7. Secret broker rejects resolved-secret material escaping callback results.
8. Filesystem source policy canonicalizes and checks symlink/ancestor containment.
9. Receipt envelopes are domain-separated and Ed25519-verifiable against explicit trust roots.
10. Qualification evidence has checksum/file-set/completeness verification and explicit stub
    rejection.

These are necessary foundations. They are not sufficient to override the blockers above.

---

## Industrial acceptance gate

Do not call SPOOL industrial/organizational production-ready until all of the following are true:

- [ ] P0-1 concurrent-DDL/contract race fixed and real-PG red-team passes.
- [ ] Exact per-SQL-piece row-effect proof added to CDC transaction commit.
- [ ] Enterprise identity + authorization + approval separation implemented or enterprise mode
      explicitly declared unsupported.
- [ ] Natural dead-owner lease takeover test passes without administrative lease deletion.
- [ ] Hard SIGKILL cutover boundary matrix passes in separate processes.
- [ ] Production checkpoint implementation is used in crash qualification.
- [ ] Dedicated red-team PostgreSQL tests pass.
- [ ] Unchanged-TOAST fidelity test passes.
- [ ] Hosted CI runners execute all required gates on exact head.
- [ ] SAST runs successfully on exact head.
- [ ] Actions are SHA-pinned for release workflows.
- [ ] Qualification class cannot overstate the profile/scenarios actually executed.
- [ ] At least MEDIUM, LARGE and INDUSTRIAL profiles are executed before those scale claims are made.
- [ ] HA/failover, backup/restore, rolling upgrade, WAL-loss, network partition and disk-full matrices pass.
- [ ] Performance SLOs are defined and met on documented reference hardware.
- [ ] 24h soak passes with bounded RSS/lag and no correctness divergence.
- [ ] Release artifacts carry independently verifiable provenance/signature and SBOM.
- [ ] Incident/recovery runbooks are exercised, not merely documented.

Until then, the defensible commercial positioning is **engineering preview / controlled pilot with
explicitly bounded scope**, not industrial-grade migration infrastructure.
