# INDUSTRIAL GAP REGISTER

Readiness denominator for the industrial consolidation. Every row is an
explicit requirement; every number below is counted from these rows —
nothing is estimated. States:

- Implementation: `COMPLETE` / `PARTIAL` / `NOT_STARTED`
- Test: `PASSING` / `PARTIAL` / `NONE`
- Qualification: `QUALIFIED` (live executed evidence passed) /
  `TESTED` (unit/integration evidence only) / `NOT_EXECUTED` / `BLOCKED`
- Blocking: `P0` (prevents release regardless of percentages) / `P1` / `P2` / `—`

## Requirement register (denominator = 36)

| ID | Capability | Pri | Required evidence | Impl | Test | Qual | Blocking | Evidence artifact | Commit | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| P-01 | Preserve & verify replica-identity fix | — | live conformance | COMPLETE | PASSING | QUALIFIED | — | `tests/conformance/postgres-cdc-replica-identity.test.js` | `691afb5` | pre-fix repro recorded in QUALIFICATION_EVIDENCE |
| P-02 | Preserve & verify write-barrier broker fix | — | live conformance | COMPLETE | PASSING | QUALIFIED | — | `tests/conformance/postgres-write-barrier-conformance.test.js` | `3ff710c` | |
| P-03 | Baseline test evidence | — | exact counts | COMPLETE | PASSING | QUALIFIED | — | QUALIFICATION_EVIDENCE R1 | `c71136d` | 552/458/0/94 |
| P-04 | Disk-space safety gate | — | fail-closed tier tests | COMPLETE | PASSING | QUALIFIED | — | `tests/qualify-disk-preflight.test.js` | `fbb0f24` | 8/8 |
| P-05 | Guarded local PostgreSQL qualification env | — | settings+auth+replication proof | COMPLETE | PASSING | QUALIFIED | — | `instance-record.json` (secret-free) | `810f1e4` | isolated instance, D1 |
| P-06 | PR ancestry + consolidation from `origin/main` | — | merge + suite | COMPLETE | PASSING | QUALIFIED | — | merge `b80e534`, R5 | `b80e534` | no force-push; main untouched |
| P-07 | Durable engineering state docs | — | 4 files exist & current | COMPLETE | NONE | QUALIFIED | — | `docs/engineering/*` | this commit | updated each unit |
| C-01 | CDC replica-identity key safety | P1 | live CDC update/delete proof | COMPLETE | PASSING | QUALIFIED | — | replica-identity conformance (4) | `691afb5` | |
| C-02 | Write-barrier credential boundary | P1 | real-credential leak test | COMPLETE | PASSING | QUALIFIED | — | barrier conformance (6) | `3ff710c` | |
| C-03 | Barrier survives backend termination | P1 | live kill + recover | COMPLETE | PASSING | QUALIFIED | — | barrier test "backend termination" | `c023d52` | was uncaught crash |
| C-04 | Target cutover barrier identity | P1 | live target barrier test | COMPLETE | PASSING | QUALIFIED | — | barrier test "target cutover barrier" | `c023d52` | was WRITE_BARRIER_UNKNOWN |
| C-05 | Cutover crash-recovery state gate | P1 | live crash matrix | COMPLETE | PASSING | QUALIFIED | — | `postgres-cutover-crash-matrix.test.js` (3/3) | `27399f2` | 3 SIGKILL cases WIN32-skipped |
| C-06 | CDC backpressure (bounded queue) | P1 | live burst-drain test | COMPLETE | PASSING | QUALIFIED | — | "burst backlog ... drains losslessly" | `1ce26fa` | `maxQueueMessages` bound |
| C-07 | CDC checkpoint durability & resume | P1 | live restart/resume | COMPLETE | PASSING | QUALIFIED | — | CDC lifecycle/conformance tests | prior | |
| C-08 | Snapshot→CDC continuity by tx identity | P1 | §16 change-window matrix | PARTIAL | PARTIAL | TESTED | P1 | CDC lifecycle test (subset of §16) | prior | during-snapshot/restart windows not fully covered |
| C-09 | Bounded spill files (bind/checksum/ceiling) | P1 | §18 integrity rules | PARTIAL | PARTIAL | TESTED | P1 | assembler spill + staging-failure tests | prior | binding/checksum rules unaudited |
| C-10 | Verification & repair exactness | P1 | live verify/repair conformance | COMPLETE | PASSING | QUALIFIED | — | verification/repair conformance | prior | |
| C-11 | Lease/fencing & worker isolation | P1 | live fencing tests | COMPLETE | PASSING | QUALIFIED | — | lease/fencing conformance | prior | |
| C-12 | SIGKILL crash recovery at every boundary | P1 | real SIGKILL matrix | PARTIAL | PARTIAL | NOT_EXECUTED | P1 | 3 tests WIN32-skipped | prior | needs POSIX host to qualify |
| C-13 | Built-browser smoke of app surface | P1 | launched-browser evidence | PARTIAL | NONE | NOT_EXECUTED | P1 | `scripts/browser-smoke.py` | prior | not executed this session |
| C-14 | Main blocked-Autopilot recovery fixes preserved | — | merged-suite proof | COMPLETE | PASSING | QUALIFIED | — | `tests/autopilot-recovery.test.js` in R5 | `1d3b3a6` | 12 listed behaviors covered by main's tests |
| Q-01 | Standalone qualification runner profiles | P0 | `run-standalone.js` 5 profiles | COMPLETE | PASSING | QUALIFIED | — | `scripts/qualify/run-standalone.js`; R6/R7 quick+postgres runs | `821aa6b` | STEP 21; exit 0 only on PASS, self-verifying |
| Q-02 | Qualification outcome model + manifest binding | P0 | PASS/FAIL/NOT_EXECUTED/BLOCKED/NOT_APPLICABLE | COMPLETE | PASSING | QUALIFIED | — | manifest schema v1 (§10 fields), `evaluateOverall` | `821aa6b` | mandatory NOT_EXECUTED/BLOCKED prevent PASS |
| Q-03 | Adversarial qualification tests (18 invariants) | P0 | fail-closed proofs | COMPLETE | PASSING | QUALIFIED | — | `tests/qualify-standalone.test.js` (20/20) | `81ffe72`, `4d605fc` | STEP 22; verifier fails closed on every contradiction |
| Q-04 | CI_CORRECTNESS profile execution | P0 | ≥100k rows, ≥30s real CDC + mandatory tests | NOT_STARTED | NONE | NOT_EXECUTED | **P0** | (planned: workload envelope stage bound into correctness profile) | — | Step 28; class claims gated until then (`4d605fc`) |
| Q-05 | Evidence writer/verifier/checksums | P1 | tamper-detection tests | COMPLETE | PASSING | QUALIFIED | — | `tests/qualify-harness.test.js` + adversarial tests 4/5/14/15 | `821aa6b` | reused by runner (no duplicate implementation) |
| D-01 | CDC drain/cutover hang: root cause established | P0 | captured position/worker/barrier state | NOT_STARTED | NONE | NOT_EXECUTED | **P0** | scratch probes on `wip/` branch | — | Step 23; no timeouts-as-success |
| D-02 | Documented drain state-machine invariant | P0 | authoritative lifecycle doc | NOT_STARTED | NONE | NOT_EXECUTED | **P0** | (planned docs entry) | — | Step 24 |
| D-03 | Drain hang root-cause fix | P0 | repro passes + no regression | NOT_STARTED | NONE | NOT_EXECUTED | **P0** | (planned) | — | Step 25; DRAIN_BLOCKED/OPERATOR_ACTION_REQUIRED if unresolved |
| D-04 | Permanent CDC tests (drain/cutover/restart/slot) | P0 | 4 separate conformance files | PARTIAL | PARTIAL | NOT_EXECUTED | **P0** | replica-identity file exists; 3 files absent | — | Step 26 |
| H-01 | Four-position CDC watermark model durable | P1 | captured/applied/acked/verified persisted separately | PARTIAL | PARTIAL | NOT_EXECUTED | P1 | `appliedLsn`+`acknowledgedLsn` in checkpoints | prior | captured/verified not first-class; §15 |
| H-02 | Source-ack ordering documented + fault-injected | P1 | ordering doc + failure between each pair | PARTIAL | PARTIAL | NOT_EXECUTED | P1 | commit-before-checkpoint tests (subset) | prior | §17 pairs not exhaustively injected |
| H-03 | Continuous verification watermark/states | P1 | §19 VERIFIED/DIFF/INCOMPLETE/BLOCKED/STALE | NOT_STARTED | NONE | NOT_EXECUTED | P1 | — | — | must bind consistency point |
| H-04 | Freshness-aware persistent monitoring | P2 | §20/§21 states + restart tests | NOT_STARTED | NONE | NOT_EXECUTED | P2 | — | — | not required for CI_CORRECTNESS |
| E-01 | Destructive-harness target identity check | P1 | host/port/db/role/marker verified fail-closed | PARTIAL | NONE | NOT_EXECUTED | P1 | marker exists in setup tool only | `810f1e4` | §22 requires harness-level check |
| E-02 | Secrets absent from evidence | P1 | scan evidence for secret values | COMPLETE | PASSING | QUALIFIED | — | QUALIFICATION_EVIDENCE integrity notes | `810f1e4` | verified by scan |

## Derived reports (counted from the 36 rows above)

### IMPLEMENTATION COMPLETION

- `COMPLETE`: **22**
- `PARTIAL`: **8** (C-08, C-09, C-12, C-13, D-04, H-01, H-02, E-01)
- `NOT_STARTED`: **6** (Q-04, D-01, D-02, D-03, H-03, H-04)
- Report: **22/36 complete (8 partial, 6 not started)**

### QUALIFICATION READINESS

- `QUALIFIED` (live evidence executed and passed): **22**
- `TESTED` (unit/integration only): **2** (C-08, C-09)
- `NOT_EXECUTED`: **12**
- Report: **22/36 qualified; 12 not executed**

### QUALIFICATION CLASS

- Target class: **CI_CORRECTNESS** (envelope: `PROFILE_DEFINITIONS.CI` =
  100,000 rows, 30s real CDC, plus all mandatory correctness tests).
- Current state: **NOT ESTABLISHED** — Q-04 has not been executed; profiles
  that PASS without a bound workload correctly report `NOT_ESTABLISHED`
  (class-claim gate, commit `4d605fc`).

### P0 BLOCKERS

1. Q-04 CI_CORRECTNESS run not executed (workload envelope not yet bound
   into the correctness profile)
2. D-01 drain-hang root cause not established
3. D-02 drain invariant not documented
4. D-03 drain fix not implemented
5. D-04 permanent CDC drain/cutover/restart tests incomplete

**P0 BLOCKERS: 5** — each prevents release regardless of the percentages
above. (Was 8; Q-01/Q-02/Q-03 resolved by `821aa6b`/`81ffe72`/`4d605fc`.)

### EXTERNAL BLOCKERS

- Disk headroom ~4.7 GiB: load/fault/pilot tiers refused by policy (D2).
  CI_CORRECTNESS (conformance tier) remains permitted with explicit
  estimate.
- No MSSQL/MySQL environments → 15 conformance tests NOT_EXECUTED.
- No POSIX host → 3 SIGKILL + 2 POSIX tests NOT_EXECUTED.
