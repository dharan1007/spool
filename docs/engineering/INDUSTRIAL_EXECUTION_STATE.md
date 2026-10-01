# INDUSTRIAL EXECUTION STATE

Authoritative resume state for the Industrial Consolidation execution
(`SPOOL_Next_Execution_Prompt_Industrial_Consolidation.txt`). Update after
every substantial implementation unit (RULE 7). Reread before starting
another unit.

## Current task

Executing the ordered STEP list from prompt section 27. See "Execution
progress" below for the exact step cursor.

## Branch and commit

- Branch: `integration/industrial-consolidation-20260930`
- Base: `origin/main` @ `1d3b3a6` (blocked-Autopilot/browser fixes) merged
  with `feat/industrial-postgres-qualification` (merge commit `b80e534`,
  `--no-ff`, single overlap file `docs/ARCHITECTURE.md` auto-merged).
- `origin/main` is never modified; only the integration branch is ever pushed.
- Prior scratch preservation: `wip/cdc-drain-debugging-20260930` @ `4e1a2d8`
  (includes `probe-*.tmp.mjs` / `*.tmp.test.js` scratch — never merge).

## Execution progress (step cursor)

| Step | Description | State |
|---|---|---|
| 1-2 | Inspect git state, preserve WIP branch | DONE |
| 3-7 | Read callers/tests, reproduce + validate replica-identity and write-barrier defects, evaluate tracing | DONE |
| 8 | Separate functional commits | DONE (`691afb5`, `3ff710c`, `7771eae`, `c71136d`) |
| 9 | Baseline full suite counts | DONE (`552/458/0/94`, 171.6s, SHA `c71136d`) |
| 10 | Disk safety gate | DONE (`fbb0f24`, `spool-disk-preflight-v1`) |
| 11-13 | Guarded local PostgreSQL qualification setup | DONE (`810f1e4`) — isolated instance, approved deviation from shared-service wording (see DECISION_LOG D1) |
| 14 | Live PostgreSQL conformance baseline | DONE — 72/72 formerly-gated tests EXECUTED and PASSED |
| 15 | PR #79/#80/#81 ancestry inspection | DONE — #79 contains #72/#75/#76 and supersedes #77; chain #79→#80→#81 all MERGEABLE; do not merge duplicates separately |
| 16 | Consolidation branch from `origin/main` | DONE |
| 17 | Integrate unique industrial content | DONE (merge `b80e534`) |
| 18 | Preserve main's blocked-Autopilot fixes | DONE — `tests/autopilot-recovery.test.js` and main-side tests execute and pass in the merged suite |
| 19 | Focused tests per integration unit | DONE throughout |
| 20 | Engineering state documents (this file set) | DONE (commit `ee4885f`) |
| 21 | Standalone qualification runner profiles | DONE (`821aa6b`, fix `4d605fc`) — quick + postgres profiles executed end-to-end |
| 22 | Adversarial qualification-runner tests (18 invariants) | DONE (`81ffe72`) — 20/20 pass (18 invariants + happy path + class-gate) |
| 23 | Reproduce CDC drain/cutover hang live | DONE — scratch repro passes on HEAD (4.6s, trace log); root-cause class established (unbounded silent wait + clean stream end never surfaced); original hang traced to `c023d52`/`1ce26fa` fixes |
| 24 | Document intended CDC drain state-machine invariant | DONE — `docs/engineering/CDC_DRAIN_LIFECYCLE.md` |
| 25 | Fix root cause (no timeout-as-success) | DONE — bounded-drain `DRAIN_BLOCKED` watchdog (timer-race wake, data-driven progress only) + durable `FAILED_RECOVERABLE` transition with §13 capture set (`#recordDrainBlocked`) |
| 26 | Promote scratch repros to permanent tests | DONE — 6 tests in `postgres-cdc-{drain-lifecycle,cutover-drain,restart-drain}.test.js` (+ existing replica-identity file); scratch deleted; suite 592/572/0/20 |
| 27 | PostgreSQL correctness/red-team suite | DONE — `--profile postgres` PASS at clean `38dbcc2` (592/20-skipped, self-verified, R10); adversarial suite 21/21 (R9 + envelope-binding pin) |
| 28 | CI_CORRECTNESS profile (only when prerequisites ready) | PARTIAL — envelope stage bound + pinned (`b2c42b7`); disk prerequisite NOT met (see below); execution BLOCKED fail-closed, class stays NOT_ESTABLISHED |
| 29 | Record evidence | PARTIAL (R1-R11 in QUALIFICATION_EVIDENCE.md; CI_CORRECTNESS run pending disk) |
| 30 | Push integration branch (never main) | NOT STARTED (next) |

## Completed changes (commits on this lineage)

- `691afb5` fix: replica-identity key columns parsed per-row
  (`src/connectors/postgres/cdc.js`, extracted pure
  `replicaIdentityKeyColumnsFromIndexRows()`); reproduced pre-fix with
  `"{id}"` string → `[]` columns → false `CDC_REPLICA_IDENTITY_UNUSABLE`.
- `3ff710c` fix: write-barrier sessions stay inside the credential broker
  (`barrierSessions` registry + opaque handle + `verifyHeld` via `pg_locks`
  + `idle_in_transaction_session_timeout=10min` backstop); pre-fix returned
  `pg.Client` → `SECRET_LEAK_DETECTED`.
- `7771eae` chore: env-gated `SPOOL_TRACE_DRAIN=1` diagnostics (bounded,
  no secrets) in `cdc-apply.js`, `command-service.js`, `write-barrier.js`.
- `c71136d` docs: regenerate `docs/CAPABILITIES.md` (fixes failing
  `tests/capability-matrix.test.js`).
- `fbb0f24` feat: reusable fail-closed disk preflight
  (`scripts/qualify/disk-preflight.js`, 8/8 unit tests).
- `810f1e4` feat: isolated disposable local PostgreSQL qualification
  instance (`scripts/qualify/setup-local-postgres.js`).
- `27399f2` fix: `commitCutover` recovery accepts `POST_CUTOVER_VERIFY`
  (pre-existing defect from `462a3af`, exposed by first live execution of
  the crash-matrix conformance test).
- `c023d52` fix: barrier backend-termination no longer crashes the process;
  `POSTGRES_TARGET_TABLE_SHARE_LOCK` valid for barrier identity; target
  acquire releases the inner lock on post-acquire failure (pre-existing
  defects from first live execution of write-barrier conformance).
- merge `b80e534`: consolidation onto `origin/main` @ `1d3b3a6`.
- `ee4885f` docs: durable engineering state files (STEP 20).
- `821aa6b` feat: standalone qualification runner
  (`scripts/qualify/run-standalone.js`) + live PostgreSQL probe
  (`scripts/qualify/pg-probe.js`) (STEP 21).
- `81ffe72` test: adversarial qualification suite, 18 section-11 invariants
  (STEP 22); also fixes `classifyStage` dropping counts/markers.
- `80fddd9` fix: npm version bound into environment evidence on Windows.
- `4d605fc` fix: CI_CORRECTNESS/PILOT class claims require a bound workload
  envelope (workload-claim + class-claim verifier rules; adversarial test 20).

- `b2c42b7` feat: CI workload envelope bound into the `correctness`
  profile (`correctness-envelope` stage running immutable
  `industrial-postgres.js --profile CI` + `workload` manifest binding +
  `correctness`-kind disk gate; adversarial pin test 21, 21/21).
- `79c2620` fix: `browser-smoke.py` repairs (it never parsed: stray
  `\"` escapes; Windows Chrome resolution; SPA client-side navigation
  for product routes, `/studio/new`, and reload) + `src/app.js`
  `ROUTES` admits product routes (in-app product links collapsed to
  `/` before). Standalone smoke: PASS exit 0 (25k rows,
  91/9 blockedDryRun, recovery, 0 exceptions).

## Tested commits and commands (resume exactly)

```bash
# Qualification PostgreSQL instance (isolated, 127.0.0.1:5433)
node scripts/qualify/setup-local-postgres.js --status
node scripts/qualify/setup-local-postgres.js --apply     # idempotent

# Load SCRAM credentials into the session (values never printed)
# env file: %LOCALAPPDATA%\spool-qualify\spooltest.env
#   SPOOL_TEST_POSTGRES_ENDPOINT / SPOOL_TEST_POSTGRES_DATABASE /
#   SPOOL_TEST_POSTGRES_USER / SPOOL_TEST_PG_PASSWORD

# Full suite WITHOUT live PostgreSQL (baseline comparison)
npm test

# Full suite WITH live PostgreSQL (expected: 0 fail; 20 non-PG skips)
node --test --test-concurrency=1 tests/*.test.js tests/conformance/*.test.js

# Gates
node scripts/static-check.js
npm run build

# Disk gate (C: must stay >= 8 GiB free for load/correctness tiers)
node -e "import('./scripts/qualify/disk-preflight.js').then(m=>console.log(m.measureDisk(process.cwd())))"

# Standalone qualification runner (exit 0 only on PASS; self-verifies)
node scripts/qualify/run-standalone.js --list
node scripts/qualify/run-standalone.js --profile quick
node scripts/qualify/run-standalone.js --profile postgres   # needs spooltest.env loaded
node scripts/qualify/run-standalone.js --profile correctness # CI_CORRECTNESS: needs spooltest.env + >=8 GiB free
node scripts/qualify/run-standalone.js --verify <evidence-dir>
node --test tests/qualify-standalone.test.js                # adversarial suite (21)
```

## Known failures / not executed

- Zero known failing tests after `27399f2` + `c023d52`.
- NOT_EXECUTED (never PASS): 8 SQL Server conformance (no MSSQL env),
  7 MySQL conformance (no MySQL env), 3 SIGKILL cutover tests
  (Windows: `process.platform === 'win32'` skip), 2 POSIX-only tests.
- Load/fault qualification tiers are refused by disk policy (correct
  behavior, not a failure). Timeline: ~4.3 GiB free → safe cache
  reclamation (npm `_cacache`, npx store incl. long-path cleanup,
  update-download/temp caches, thumb/pip caches; user Downloads and all
  project data untouched) → **8.44 GiB** (correctness tier admitted) →
  concurrent external machine activity consumed ~5.5 GiB within ~20 min
  → 2.89 GiB. The `correctness`-kind disk gate then correctly refused
  the envelope run (all stages NOT_EXECUTED, FAIL, self-verification
  OK): the fail-closed design working as specified. See R11.

## Remaining defects (open)

- CI_CORRECTNESS execution has not run (Step 28): the envelope stage and
  workload binding are implemented and pinned (`b2c42b7`), but the
  `correctness`-kind disk gate (8 GiB floor, D2) cannot be satisfied
  while concurrent external activity consumes C: faster than safe
  reclamation allows. Attempt #1 executed 11/14 stages (all PASS until
  the since-fixed browser-smoke defect); attempt #2 was refused at
  2.89 GiB. Rerun `--profile correctness` when >=8.2 GiB is stably
  free. This is the last P0 blocker (`INDUSTRIAL_GAP_REGISTER.md`
  Q-04).
- Known bounded-drain gap (documented in `CDC_DRAIN_LIFECYCLE.md`,
  non-blocking for Steps 23-26): the stall watchdog runs in the pump's
  empty-queue wait branch; a target-side apply that blocks indefinitely
  (e.g. locked target table) keeps the queue non-empty and is not
  covered. Pre-existing class, distinct from the fixed silent-stream
  hang; registered as follow-up, not papered over.
- Qualification runner exists and is proven on quick + postgres profiles
  (resolved Steps 21-22; adversarial suite 20/20).

## Important architectural decisions

See `DECISION_LOG.md` (D1-D10+). Readiness numbers come exclusively from
`INDUSTRIAL_GAP_REGISTER.md`; test counts come exclusively from
`QUALIFICATION_EVIDENCE.md`.
