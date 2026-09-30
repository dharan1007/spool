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

### PostgreSQL live status summary

| Area | Tests | Live result |
|---|---|---|
| Replica identity conformance | 4 | PASS (R2, R5) |
| Write-barrier conformance (incl. broker-leak, backend-termination, target barrier) | 6 | PASS (R2, R5) |
| CDC conformance (backpressure, lifecycle, atomicity, restart) | all gated | PASS (R4, R5) |
| Cutover crash matrix | 3 executed + 3 WIN32 skips | PASS (R4, R5) |
| Verification, repair, lease/fencing, catalog, snapshot, soak, fault-injection | all gated | PASS (R4, R5) |
| **Total formerly-gated PG tests executed** | **72** | **0 failures** |

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
| Current | ~4.68 GiB | conformance tier only (headroom > 1 GiB still holds) |

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
- No evidence file contains secret values (record scanned against the env
  file; only `password_encryption` setting names appear).
- CI_CORRECTNESS profile run (Step 28) is NOT YET EXECUTED; no class claim
  exists until it is.
