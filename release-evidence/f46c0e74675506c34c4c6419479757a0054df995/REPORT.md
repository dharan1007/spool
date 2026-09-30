# Release Evidence Report — PostgreSQL CDC Cutover Correctness + Qualification Trustworthiness

Commit: `f46c0e74675506c34c4c6419479757a0054df995`
Branch: `feat/industrial-postgres-qualification`
Date: 2026-09-20

## Verdict

All gates green on the exact commit, clean tree. Qualification PASS with
`releaseGrade=true`, bundle independently verified. See `bundle.json` for
per-artifact hashes and `gates/` for raw logs.

## Gates (raw logs in `gates/`)

| Gate | Result | Log |
|---|---|---|
| Unit suite | 486 tests, 419 pass, 0 fail, 67 skipped (env-gated) | `unit.log` |
| PG conformance (spool-pg17, sequential) | 56/56 pass | `postgres-conformance.log` |
| Production purity + static release check | pass | `static-check.log` |
| SVMP model | ok, 1640 states, 16 invariants | `svmp-model.log` |
| `npm run check` (release-gate) | PASS | `check.log` |
| Build (reproducible dist) | pass | `build.log` |
| Industrial PG qualification, CI profile | PASS, 9/9 scenarios, 0 stubs | `qualification-run.log` |
| Independent evidence verification | exit 0, releaseGrade=true | `evidence-verify.log`, `qualification/` |

Re-verify the qualification bundle any time with:
`node scripts/qualify/verify-evidence.js release-evidence/f46c0e74675506c34c4c6419479757a0054df995/qualification`

## What this release proves

**CDC cutover correctness** (`src/daemon/command-service.js`,
`src/connectors/postgres/cdc-apply.js`, `src/protocol/verification-coordinator.js`):
- Ordering no-gap argument: slot reservation (P) → approval snapshot (S) →
  full-load commit → stream apply, through idempotent PK upserts/deletes.
- `establish-cdc-boundary` / `catch-up-cdc` / `FINAL_DRAIN` (shared leased
  execution, heartbeat-terminated) / `release-cdc-boundary` (owned slots only).
- Cutover proofs replay the live source with exact content equality plus
  session row-count equality and ledger coherence; repair after CDC advance
  is refused; mid-load streaming is refused; quiesce is required for commit
  (racing writes fail the fresh proofs closed).
- Proven end-to-end by `tests/conformance/postgres-cdc-lifecycle.test.js`
  (boundary → approve → run → catch-up → arm → commit → release).

**Qualification trustworthiness** (`scripts/qualify/`):
- Required-scenario manifest with static imports; missing modules crash
  instead of passing as stubs. Returned failures propagate to FAIL.
- Real `statfs` disk preflight; required-scenario completeness gates
  INCOMPLETE (exit 3); raw.jsonl stub tripwire; manifest v2 (pinned file
  set, per-scenario status); single checksums write, last.
- The verifier enforces contents, file-set equality, schema, failures
  consistency, scenario completeness, zero stubs, and verdict-follows-
  evidence (including `releaseGrade ⇒ PASS ∧ clean`).

## Known limits (not claimed)

- GitHub Actions/CodeQL remain externally blocked (account billing); no CI
  ran on this branch. All evidence above is local.
- MySQL (7) + MSSQL (8) conformance tests stay `EXPERIMENTAL`/env-gated;
  2 PLATFORM skips; PG proven on v17 only (spool-pg17 + supabase 17.6).
- Cutover requires a quiesced source; large-scale (10M+ rows), long-soak,
  fencing/HA, backup/restore and rolling-upgrade qualification not yet run.
- `streamPostgresChanges` (debug helper) still awaits `subscribe()`, which
  settles only at stream end — fine for its bounded-capture tests, would
  hang on an unreachable waterline. Production path uses the fixed applier.
