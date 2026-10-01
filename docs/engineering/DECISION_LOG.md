# DECISION LOG

Material architectural and process decisions for the industrial
consolidation. Newest decisions append; existing entries are not rewritten
(rationale is history).

## D1 â€” Qualification PostgreSQL runs as an isolated second instance

**Date:** 2026-09-30
**Context:** Step 12 originally assumed enabling `wal_level=logical` on the
machine's PostgreSQL 17 Windows service. Identity inspection revealed that
service hosts 14 unrelated project databases (`maleu_bridge_prodshape`,
`raedius_shipping_shadow`, `nishtha`, `raw_db`, ...) on a shared cluster with
~4.9 GiB free disk.
**Decision (user-approved):** create a fully isolated second cluster via
`initdb` at `%LOCALAPPDATA%\spool-qualify\pg-data`, port 5433,
`listen_addresses='127.0.0.1'`, managed only by
`scripts/qualify/setup-local-postgres.js`. The shared service cluster is
never reconfigured, restarted, or written to.
**Why:** stop-condition "an operation could affect an unrelated real
database"; also isolates qualification WAL growth from other projects' data.
**Consequences:** the instance is not a Windows service; re-run `--apply`
after reboot (~30s). Marker file `.spool-qualification-instance` gates every
mutation/restore; `--restore` deletes only tool-created resources.

## D2 â€” Disk policy is a hard fail-closed gate, not a warning

**Date:** 2026-09-30
**Decision:** `scripts/qualify/disk-preflight.js` (`spool-disk-preflight-v1`)
classifies workloads: <8 GiB free refuses live load/fault/correctness
qualification (bounded conformance only, explicit peak estimate); 8-15 GiB
bounded correctness; 15-40 GiB bounded pilot; >=40 GiB larger. Always keep
>=1 GiB projected headroom. Unknown kind/estimate/measurement â†’ refuse.
**Why:** the repository already contains PostgreSQL PANIC evidence under
insufficient headroom; C: sits at ~4.7 GiB free.
**Consequences:** CI_CORRECTNESS's >=100k-row/30s-CDC envelope must be run
only with an explicit conformance-tier estimate, or after disk is freed; no
workload may be silently reduced while keeping a larger class name.

## D3 â€” Qualification secrets live only outside the repository

**Date:** 2026-09-30
**Decision:** generated passwords (`SPOOL_QUALIFY_ADMIN_PASSWORD`,
`SPOOL_TEST_PG_PASSWORD`) are written only to
`%LOCALAPPDATA%\spool-qualify\spooltest.env` (mode 0600 semantics), loaded
into test processes via environment, never printed, never committed, never
placed in `instance-record.json` or any evidence bundle (verified by
scanning the record for secret values).
**Why:** prompt section 22 + THREAT_MODEL; evidence bundles are shared.

## D4 â€” Consolidation base and merge strategy

**Date:** 2026-09-30
**Decision:** `integration/industrial-consolidation-20260930` is created
from `origin/main` (`1d3b3a6`) and the industrial feature branch is merged
with `--no-ff` (single auto-merged overlap: `docs/ARCHITECTURE.md`). No
force-push ever; only the integration branch is pushed (Step 30); `main` is
never directly modified; PR chain #79/#80/#81 stays as-is (do not separately
merge #72/#75/#76/#77 â€” #79 contains and supersedes them).
**Why:** section 1/6/7 of the consolidation prompt; ancestry inspection
proved the overlap content is identical.

## D5 â€” Barrier sessions cross no boundary as client objects

**Date:** 2026-09-30
**Decision:** live `pg.Client` handles live only in the module-level
`barrierSessions` registry inside `src/cutover/write-barrier.js`; callers
receive an opaque random handle; the hardened broker fails any result that
carries secret material (`SECRET_LEAK_DETECTED`).
**Why:** the pre-fix implementation returned a `pg.Client` from the broker
callback scope â€” reproducible leak. Registry mirrors the pool registry in
`connection.js`.

## D6 â€” Target barrier kind is separate from source kinds

**Date:** 2026-09-30
**Decision:** `WRITE_BARRIER_KINDS` (source) stays exactly
`[POSTGRES_TABLE_SHARE_LOCK, EXTERNAL_OPERATOR_BARRIER]`; new
`TARGET_WRITE_BARRIER_KINDS = [POSTGRES_TARGET_TABLE_SHARE_LOCK]`;
`barrierIdentity` validates against both, `describeBarrierKind` keeps its
source-only default contract.
**Why:** first live execution of write-barrier conformance proved the target
cutover barrier could never be acquired (`WRITE_BARRIER_UNKNOWN`). Mixing the
kinds into one list would let a target kind masquerade as a source barrier.

## D7 â€” Cutover recovery accepts both Phase-2 entry states

**Date:** 2026-09-30
**Decision:** the `commitCutover` post-Phase-1 gate accepts exactly
`CUTOVER_COMMITTED` and `POST_CUTOVER_VERIFY`; any other durable state fails
closed with `CUTOVER_NOT_ARMED`.
**Why:** Phase 2 already documents reuse of the immutable post-cutover proof
after restart in `POST_CUTOVER_VERIFY`; the old `!== CUTOVER_COMMITTED` gate
contradicted it (live crash-matrix failure). No test pinned the old message.

## D8 â€” Trace instrumentation is opt-in and bounded

**Date:** 2026-09-30
**Decision:** drain/cutover diagnostics emit only under
`SPOOL_TRACE_DRAIN=1`, to stderr, with bounded cardinality, no secrets, no
row payloads.
**Why:** Steps 5/7 require evidence capability without changing default
behavior or leaking data.

## D9 â€” Qualification runs Actions-free

**Date:** 2026-09-30
**Decision:** all qualification evidence is produced by local commands
(`node scripts/qualify/...`, `node --test`); GitHub Actions is never used,
triggered, or cited as evidence. Skipped live tests are reported
`NOT_EXECUTED`, never `PASS`.
**Why:** explicit prompt constraint; environment cannot run Actions.

## D10 â€” CI_CORRECTNESS before any higher class

**Date:** 2026-09-30
**Decision:** the first qualification target is CI_CORRECTNESS using the
authoritative repository envelope `PROFILE_DEFINITIONS.CI` (100,000 rows,
30s real CDC, `scripts/qualify/profiles.js`) plus all mandatory correctness
tests. PILOT+ tiers are blocked by disk policy (D2) and by CI_CORRECTNESS
not yet being established.
**Why:** sections 23/24; claiming higher classes without evidence is
forbidden (section 25).

## D11 â€” Class claims are gated on bound workload evidence

**Date:** 2026-09-30
**Decision:** `qualificationClass` may only be `CI_CORRECTNESS`/`PILOT`
when the run is PASS **and** the profile's workload envelope is bound in
the manifest; otherwise `NOT_ESTABLISHED`. The verifier independently
checks `class-claim` and `workload-claim`.
**Why:** a live `--profile postgres` run initially reported
`CI_CORRECTNESS` with `workload: null` â€” evidence-less class claim,
exactly what section 25 forbids. Fixed in `4d605fc` with adversarial test
20.

## D12 â€” Skips are an explicit profile contract

**Date:** 2026-09-30
**Decision:** each `node --test` stage declares `skipAllow` patterns
(`FULL_SUITE_SKIP_ALLOW` = SQL Server, MySQL, SIGKILL, POSIX-only tests on
this host). A skip outside the contract makes the mandatory stage
NOT_EXECUTED, which prevents overall PASS. Skip counts are cross-checked
against named skip lines so unattributable skips fail closed.
**Why:** section 10 ("a skipped mandatory test is NOT_EXECUTED, not PASS");
counting skip numbers alone cannot prove *which* tests skipped.

## D13 — DRAIN_BLOCKED lands in FAILED_RECOVERABLE, not FAILED_OPERATOR_REQUIRED

**Date:** 2026-09-30
**Decision:** when a bounded CDC drain exhausts its stall window without
data-driven progress, the applier fails with `DRAIN_BLOCKED` and the daemon
durably transitions the migration to `FAILED_RECOVERABLE` with
`reason: 'DRAIN_BLOCKED'` and the full section-13 capture set as evidence.
`FAILED_OPERATOR_REQUIRED` stays reserved for states where no automatic
retry can be correct (destructive ambiguity, lost authority).
**Why:** the drain block is a diagnosable environment/stream condition, not
an operator decision: the durable applied watermark is intact, so a retry
resumes exactly where progress stopped. Putting it in a terminal operator
state would discard the recovery path the checkpoint already provides. The
failure is still loud, durable, and self-explaining — a timeout never
resolves an unresolved drain as success (section 13).
**Consequences:** `#recordDrainBlocked` tolerates only
`ILLEGAL_STATE_TRANSITION` (a concurrent transition already moved the
state); the original `DRAIN_BLOCKED` diagnosis is always rethrown to the
caller unchanged.

## D14 — Drain progress means data or applied work, never heartbeats

**Date:** 2026-09-30
**Decision:** the bounded-drain stall watchdog resets only when a source
message is queued or a transaction is applied. Server keepalive heartbeats
feed only the watermark/idle-stop check; they never count as progress. The
watchdog applies only to bounded drains (`untilLsn` or `maxTransactions`);
unbounded continuous-capture runs are excluded and end only on stream
failure (including a clean subscription end, which the pump treats as
stream failure instead of waiting forever).
**Why:** a stream that heartbeats but never carries data is exactly the
livelock the section-13 rules target; counting heartbeats would paper over
it. The wake is a timer racing the notification promise because a fully
silent stream never resolves `notified`.
**Consequences:** `cdc-apply.js` carries an explicit `sleep-sync`
allowlist entry: the deadline converts an unresolved drain into a
`DRAIN_BLOCKED` failure and never into success.

## D15 — CI_CORRECTNESS claims require a bound, immutable, executed envelope

**Date:** 2026-10-01
**Decision:** the `correctness` runner profile binds a `workload`
manifest object (`profile: CI`, 100k rows, >=30s real CDC, from
`PROFILE_DEFINITIONS.CI`) and runs it as a mandatory
`correctness-envelope` stage (`industrial-postgres.js --profile CI`).
Its disk gate is `correctness`-kind (8 GiB floor): at lower headroom the
profile refuses before anything runs. The envelope script records its own
effective configuration and rejects a diverged immutable name, so the
workload cannot be silently downsized while keeping the CI label — the
same guarantee `resolveProfile` gives ad-hoc runs, now wired into the
runner contract (Q-04). The conformance-level `postgres` profile keeps
`workload: null` and therefore can never report the class as established
(D11 stands).
**Why:** sections 23/24 (class definition) + D2 (disk tiers): executing a
class without its envelope, or with a reduced envelope, is exactly the
false claim the class-claim/workload-claim verifiers exist to prevent.
**Consequences:** `release`/`pilot` inherit the envelope stage through the
`correctness` spread; the adversarial suite pins the binding (test 21).

## D16 — Never-executed stages are defect surface, not coverage

**Date:** 2026-10-01
**Decision:** the first-ever `correctness` profile run exposed that
`browser-smoke.py` never parsed (stray escapes), never resolved Windows
Chrome, and navigated SPA routes in a way no plain static server can
serve — plus a real app defect (`ROUTES` excluded product routes, so
in-app product links collapsed to `/`). All repaired in `79c2620` with
standalone PASS evidence; the smoke artifact paths are gitignored.
**Why:** "run the suite" (Step 27) is what these gates are for — a stage
that never executes contributes nothing and rots. Stop conditions say
investigate and repair on failure, which is what happened.
**Consequences:** `src/app.js` navigation now admits product routes;
production hosting needed no change (Vercel rewrite already covers SPA
fallback).

## D17 — Envelope scenarios inherit the harness release identity

**Date:** 2026-10-01
**Decision:** `industrial-postgres.js` binds its captured HEAD SHA into
`process.env.SPOOL_COMMIT_SHA` (explicit overrides win) before running
scenarios, so scenario-built production command services carry an exact
release identity.
**Why:** the `RELEASE_IDENTITY_REQUIRED` gate (exact 40-hex SHA) failed
5 scenarios at once — the harness, not the product, was at fault: the
scenarios already read the `SPOOL_COMMIT_SHA` seam, but nothing set it.
Failing the envelope on identity instead of workload behavior would have
been a false signal.
**Consequences:** one-line harness change (`c366902`); no scenario or
product code touched.

## D18 — Scenario mappings use the same casts as conformance proofs

**Date:** 2026-10-01
**Decision:** the worker-load scenario maps CSV string ids through
`cast_number`, mirroring the conformance fixtures.
**Why:** without the cast every row rejected with TYPE_MISMATCH while
the run honestly reported COMPLETE-with-rejections and exact accounting
— 0 target rows with a green run state. The product was correct; the
scenario mapping was written against an assumed integer source.
Reproduced at small scale, fixed in one line (`9965e99`), re-verified
exact (2x1000 rows, 0 failures) before the official run.
**Consequences:** envelope workers prove exact parallel writes.
