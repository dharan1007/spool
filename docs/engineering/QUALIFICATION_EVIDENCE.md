# QUALIFICATION EVIDENCE

Every count below was produced by an actual command on this machine. No
estimated or aspirational counts appear here. `NOT_EXECUTED` means exactly
that — never `PASS`.

## Test runs

### R1 — Baseline full suite (no live PostgreSQL), pre-consolidation

- Command: `npm test`
  (`node --test --test-concurrency=1 tests/*.test.js tests/conformance/*.test.js`)
- Date/SHA: 2026-09-30 @ `c71136d`, tree clean
- Result: **552 discovered / 458 passed / 0 failed / 94 skipped**, 171.6s,
  exit 0
- Skips: 72 live-PostgreSQL gated (NOT_EXECUTED), 8 SQL Server, 7 MySQL,
  7 POSIX/flag — all NOT_EXECUTED.

### R2 — Focused live PostgreSQL regression pair (post-fix)

- Command: `node --test tests/conformance/postgres-cdc-replica-identity.test.js
  tests/conformance/postgres-write-barrier-conformance.test.js` with
  `spooltest.env` loaded
- Result: **10 / 10 passed / 0 failed / 0 skipped**, exit 0
- Before the fixes in `c023d52` this same command produced
  `not ok` on backend-termination (uncaught `Connection terminated
  unexpectedly`) and target cutover barrier (`WRITE_BARRIER_UNKNOWN`), then
  hung on a leaked barrier session — that failure output is the
  pre-fix reproduction evidence.

### R3 — Full live suite before the crash-matrix fix

- Command: `node --test --test-concurrency=1 tests/*.test.js
  tests/conformance/*.test.js` with `spooltest.env` loaded
- Result: **561 / 540 / 1 failed / 20 skipped**, exit 1
- Sole failure: `crash matrix resumes deterministically from every durable
  cutover boundary` → `CUTOVER_NOT_ARMED ... not POST_CUTOVER_VERIFY`
  (pre-existing gate defect; fixed in `27399f2`).

### R4 — Full live suite after R3 fix (feature branch)

- Result: **561 / 541 / 0 failed / 20 skipped**, exit 0
- Skips = 8 SQL Server + 7 MySQL + 3 SIGKILL-on-Windows + 2 POSIX
  (verified by enumerating every `# SKIP` line; zero PostgreSQL skips).

### R5 — Consolidated integration branch verification (merge `b80e534`)

- Command: same as R4 on `integration/industrial-consolidation-20260930`
- Result: **566 / 546 / 0 failed / 20 skipped**, exit 0
  (566 = 561 branch tests + 5 tests added by main's `1d3b3a6` commit)
- `node scripts/static-check.js` → PASS (19 required artifacts, stable
  SQLite runtime, no source-network primitives, JS syntax valid).

### R6 — Standalone runner `--profile quick` (STEP 21 proof)

- Command: `node scripts/qualify/run-standalone.js --profile quick`
- SHA `81ffe72`, tree clean at start and end; evidence dir
  `qualification/standalone-quick-2026-09-30T18-15-08-280Z` (gitignored).
- Result: **PASS**, exit 0, self-verification OK.
- Stages (all PASS): disk-preflight (conformance tier, 4.54 GiB free),
  dependency-validation (`npm ls --depth=0`), static-check (marker
  `Static release check passed`), core-unit (12 tests), browser-source
  (8 tests). Aggregate: **20 tests / 20 pass / 0 fail / 0 skipped**,
  class `SMOKE`, manifest binds git SHA start==end and clean tree.

### R7 — Standalone runner `--profile postgres` with live PostgreSQL (STEP 21 proof)

- Command: `node scripts/qualify/run-standalone.js --profile postgres`
  with `spooltest.env` loaded; SHA `4d605fc`, clean tree.
- Result: **PASS**, exit 0, self-verification OK.
- Stages: disk-preflight PASS; `postgres-probe` PASS (316ms,
  `LIVE_PG_PROBE OK` + meta: host 127.0.0.1:5433, database spooltest,
  user spooltest, `PostgreSQL 17.5 on x86_64-windows`, wal_level
  logical); `postgres-live-suite` PASS (339s).
- Aggregate: **586 tests / 566 pass / 0 fail / 20 skipped / 566 executed**.
  The 20 skips are exactly the allowlisted set enforced by the stage
  contract (`FULL_SUITE_SKIP_ALLOW`): 8 SQL Server, 7 MySQL, 3 SIGKILL on
  Windows, 2 POSIX-only. Any other skip would have forced NOT_EXECUTED.
- Class reported: **NOT_ESTABLISHED** — correct, because no workload
  envelope is bound in this profile (class-claim gate, commit `4d605fc`).

### R8 — Adversarial qualification suite (STEP 22 proof)

- Command: `node --test tests/qualify-standalone.test.js`
- Result: **20 / 20 passed / 0 failed / 0 skipped**, exit 0.
- Covers all 18 section-11 invariants plus sound-PASS happy path plus the
  workload-gated class claim.

### R9 — CDC drain lifecycle root-cause unit (STEPS 23-26 proof)

- §23 repro attempt: the scratch drain repro
  (`SPOOL_TRACE_DRAIN=1`, full trace in `%TEMP%\drain-repro-1.log`)
  **passed in 4.6s on HEAD** — the original hang no longer reproduces.
  Forensics attribute it to the barrier-session leak fixed in `c023d52`
  and the queue-drop fix in `1ce26fa`; the remaining root-cause class is
  an unbounded `await notified` wait when the stream goes silent, plus a
  clean subscription end that never surfaced to the pump (documented in
  `CDC_DRAIN_LIFECYCLE.md`). Scratch repro promoted and deleted (§14).
- Permanent tests added (6): `postgres-cdc-drain-lifecycle` (3: bounded
  DRAIN_BLOCKED with full capture set, unbounded watchdog exclusion +
  stream-failure termination, FAILED_RECOVERABLE durable transition),
  `postgres-cdc-cutover-drain` (1: armed cutover freezes catch-up, final
  drain converges a quiesced source in bounded time under the canonical
  `cutover:<attempt>:final-drain` command identity),
  `postgres-cdc-restart-drain` (2: watermark restart returns without
  re-applying, bounded partial drain resumes exactly the remainder).
- Two defects were found by these tests and fixed before any claim: the
  DRAIN_BLOCKED capture set assumed an async checkpoint reader
  (`load().catch` on the run-store's synchronous adapter) and the pump
  could wait forever after a clean subscription end.
- Command: `npm test` with `spooltest.env` loaded, working tree containing
  the final Steps 23-26 code.
- Result: **592 discovered / 572 passed / 0 failed / 20 skipped**, exit 0,
  365.5s. Skips are exactly the 20-item `FULL_SUITE_SKIP_ALLOW` contract
  (8 SQL Server, 7 MySQL, 3 SIGKILL-Windows, 2 POSIX).
- `node scripts/static-check.js` → PASS (explicit `sleep-sync` allowlist
  entry for the drain stall deadline with justification; the timer only
  converts an unresolved drain into `DRAIN_BLOCKED`, never into success).

### R10 — Standalone runner `--profile postgres` at the drain-fix line (STEP 27 proof)

- Command: `node scripts/qualify/run-standalone.js --profile postgres`
  with `spooltest.env` loaded; SHA `38dbcc2`, clean tree.
- Result: **PASS**, exit 0, self-verification OK.
- Stages: disk-preflight PASS; `postgres-probe` PASS; `postgres-live-suite`
  PASS (374s).
- Aggregate: **592 tests / 572 pass / 0 fail / 20 skipped / 572
  executed** (includes the 6 permanent drain-lifecycle/cutover/restart
  tests). Skips are exactly the 20-item `FULL_SUITE_SKIP_ALLOW`
  contract. Class: **NOT_ESTABLISHED** (no workload bound in this
  profile — correct per the class-claim gate).
- Evidence: gitignored
  `qualification/standalone-postgres-2026-09-30T19-59-00-923Z`.

### R11 — Correctness profile: envelope bound, execution blocked fail-closed (STEP 28 proof)

- Prerequisite implemented (`b2c42b7`): the `correctness` profile now
  carries a `correctness-envelope` mandatory stage
  (`industrial-postgres.js --profile CI`, i.e. immutable 100k rows /
  30s real CDC) plus a matching `workload` manifest binding; its disk
  gate is `correctness`-kind (8 GiB floor, D2). Adversarial suite
  extended to **21/21 PASS**, including pin test 21 (envelope present,
  mandatory, bound; `postgres` profile still binds nothing).
- Attempt #1 (`qualification/standalone-correctness-2026-10-01T04-50-13-441Z`):
  all 11 pre-envelope stages PASS (incl. `postgres-correctness`,
  172s); `browser-smoke` **FAIL** in 225ms — the script itself did not
  parse (stray `\"` escapes, line 233). The stage never executed before,
  so the defect sat latent; downstream stages correctly went
  NOT_EXECUTED and the profile reported FAIL / NOT_ESTABLISHED.
- Repairs (`79c2620`, each verified): (1) string-escape syntax fix;
  (2) Windows well-known Chrome/Chromium resolution (`SPOOL_BROWSER`
  override kept); (3) SPA client-side navigation for product routes,
  `/studio/new`, and post-results reload (plain `http.server` has no
  fallback rewrite); (4) `src/app.js` `ROUTES` admits product routes
  (in-app product links collapsed to `/` before; production `vercel.json`
  already rewrites, so no hosting change needed).
- Standalone smoke after repairs: **PASS, exit 0** (CDP bootstrap, all 4
  product routes with needles, 25k-row Autopilot COMPLETE_WITH_REJECTIONS,
  91/9 blockedDryRun + button recovery, IndexedDB restoration across
  reload, 0 runtime exceptions, 0 failed loads). `browser-smoke.png` and
  `__pycache__/` added to `.gitignore` (stage artifacts).
- Attempt #2 (`qualification/standalone-correctness-2026-10-01T05-06-08-809Z`):
  C: at 2.89 GiB → the `correctness`-kind disk gate correctly REFUSED →
  all 11 stages NOT_EXECUTED → FAIL / NOT_ESTABLISHED, self-verification
  OK. Fail-closed refusal evidence, not a product failure.
- Disk timeline this session (GiB free on C:): 4.30 → safe cache
  reclamation (npm `_cacache`, npx store with long-path cleanup, update
  downloads, temp/thumb/pip caches; user Downloads and all project data
  untouched) → **8.44** (correctness tier admitted) → concurrent
  external machine activity consumed ~5.5 GiB in ~20 min → 2.89.
  Execution stays NOT_EXECUTED until headroom is stably ≥8.2 GiB.

### PostgreSQL live status summary

| Area | Tests | Live result |
|---|---|---|
| Replica identity conformance | 4 | PASS (R2, R5) |
| Write-barrier conformance (incl. broker-leak, backend-termination, target barrier) | 6 | PASS (R2, R5) |
| CDC conformance (backpressure, lifecycle, atomicity, restart) | all gated | PASS (R4, R5) |
| Cutover crash matrix | 3 executed + 3 WIN32 skips | PASS (R4, R5) |
| Verification, repair, lease/fencing, catalog, snapshot, soak, fault-injection | all gated | PASS (R4, R5) |
| **Total formerly-gated PG tests executed** | **72** | **0 failures** |
| Standalone runner profiles (R6 quick, R7 postgres) | 5 stages each | PASS, self-verified, exit 0 |
| Adversarial qualification suite (R8) | 20 | PASS |
| CDC drain lifecycle unit (R9: drain-lifecycle, cutover-drain, restart-drain) | 6 | PASS (live PostgreSQL) |
| Standalone runner postgres profile at drain-fix line (R10) | 592 / 20 skipped | PASS, self-verified |
| Adversarial suites (R8: 20, R11 pin test 21) | 21 | PASS |
| Correctness profile (R11): 11/14 stages executed | 11 × PASS, envelope blocked by disk gate | FAIL-closed (refusal, not product failure) |

## Environment

- Host: Windows NT 10.0.26200; Node v22.23.2; npm 11.6.1; git 2.51;
  Python 3.11.9; no GitHub Actions used (D9).
- Qualification PostgreSQL (isolated instance, D1): **PostgreSQL 17.5**,
  data dir `%LOCALAPPDATA%\spool-qualify\pg-data`, port **5433**,
  `127.0.0.1` only, marker `.spool-qualification-instance`.
  Recorded settings (`instance-record.json`, contains no secrets):
  `wal_level=logical`, `max_replication_slots=10`, `max_wal_senders=10`,
  `max_connections=50`, `password_encryption=scram-sha-256`,
  `server_encoding=UTF8`, `TimeZone=Asia/Calcutta`.
  Auth: SCRAM-SHA-256 for `127.0.0.1/32` (all + replication rules);
  no trust authentication on the qualification role.
  Verified on apply: role connect over TCP with password, fixture
  CREATE/INSERT/SELECT/DROP, logical replication slot create/drop
  (`pgoutput`) as `spooltest`.
- Shared service cluster (14 unrelated databases) untouched.

## Disk measurements (fail-closed policy evidence)

| Time | Free (C:) | Gate effect |
|---|---|---|
| Start of session | ~4.94 GiB | conformance allowed, load/fault refused |
| After instance creation | 4.90 → 4.73 GiB | same tier |
| During drain unit (Steps 23-26) | ~4.3-4.6 GiB | conformance tier only (headroom > 1 GiB still holds) |
| After safe cache reclamation (Step 28 prep) | **8.44 GiB** | correctness tier admitted (8 GiB floor + ~230 MiB CI estimate + 1 GiB headroom all hold) |
| Before correctness attempt #2 | 2.89 GiB | external machine activity consumed ~5.5 GiB; correctness refused fail-closed |

Policy: `spool-disk-preflight-v1` (`scripts/qualify/disk-preflight.js`),
unit-tested 8/8 (`tests/qualify-disk-preflight.test.js`) incl. exact tier
boundaries and fail-closed malformed inputs.

## NOT_EXECUTED inventory (never report as PASS)

- 8 SQL Server conformance tests — requires `SPOOL_TEST_MSSQL_*` env.
- 7 MySQL conformance tests — requires `SPOOL_TEST_MYSQL_*` env.
- 3 SIGKILL cutover tests — `process.platform === 'win32'` guarded.
- 2 POSIX-only tests (mode bits / unwritable-target).
- Load, fault, pilot, industrial profiles — refused by D2 disk policy at
  current headroom (expected refusal, recorded as NOT_EXECUTED).

## Evidence integrity notes

- Run logs for R2-R5 were captured during execution
  (`%TEMP%\opencode\*.log`); counts above are transcribed verbatim.
- R6/R7/R8 evidence lives in gitignored
  `qualification/standalone-*` directories with `sha256sums.txt`; the
  runner's `--verify` command re-checks checksums, file set, stage logs,
  counts, git binding and class claim independently (fails closed).
- No evidence file contains secret values (record scanned against the env
  file; only `password_encryption` setting names appear).
- CI_CORRECTNESS profile run (Step 28) is NOT YET EXECUTED; every profile
  currently reports `NOT_ESTABLISHED` for workload-requiring classes until
  the 100k-row/30s-CDC envelope is bound.
