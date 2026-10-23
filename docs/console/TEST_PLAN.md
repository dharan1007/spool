# SPOOL Console test plan

All Console tests run against the real engine (`loadEngine(<repo>/src)`), never
against mocks. The same code paths run in packaging against
`apps/console/engine/` with a hash manifest binding.

## Suites (apps/console)

Run: `npm test` inside `apps/console` (executes sync-engine first so the
manifest always matches the checked-out commit).

| Suite | What it proves |
| --- | --- |
| `tests/console-service.test.js` | workspace + migration creation through the engine; plan/dry-run plumbing |
| `tests/full-journey.test.js` | the complete operator journey: inspect → create → plan → dry-run (5/5 valid) → approval → execute COMPLETE → engine receipt + verification → 5 written rows in the target → evidence export → **tamper rejection** → history status |
| duplicate-execute case | second `execute()` on a RUNNING migration fails with `MIGRATION_ALREADY_RUNNING` (synchronous guard) |
| modified-source case | appending a row after planning fails plan/dry-run with `SOURCE_UNCHANGED_CHECK_FAILED` |
| `tests/ipc-contract.test.js` | unknown operations, undeclared extra fields, workspace-not-found envelopes; `CONTRACT_VERSION` |
| `tests/evidence.test.js` | schema + migration leaf paths in `workspace-store.js` |
| `tests/mapping.test.js` | duplicate targets, unknown targets, allow-listed operators, schema signatures, recipe import version binding (all engine-checked) |

## Electron-level journey harness

`apps/console/scripts/harness.js` boots the exact privileged graph used by the
main process (engine bundle at `apps/console/engine`, production IPC router,
contract validation) and drives: verifyRelease → source inspect → destination
listing → workspace create → create → plan → dry-run → approve → execute →
receipt → evidence export/verify → negative unknown-op probe. Output is a
single JSON document; the recorded run is committed at
`.console-evidence/ipc-harness.json` (40/40 rows, receipt verification
VERIFIED, written 40 / rejected 0, `evidenceVerified: true`,
`unknownOpRejected: CONSOLE_VALIDATION_FAILED`).

## Window-level evidence

- Development run and **packaged** run (`dist/package/win-unpacked/SPOOL
  Console.exe`) both booted with empty stderr; screenshots committed:
  `.console-evidence/packaged-window.png` (packaged, real Windows process).
- The renderer shows the wizard running against the packaged engine manifest
  (`engine 1.1.2 · c9f8299…`), which is the release identity the boot check
  verified.

## Root repository regression contract

The Console must not regress the engine's own suites. The release preparation
records:

- `npm test` (root) — 540 tests: 476 pass, 64 skip (external-DB conformance
  self-skips); log at `.console-evidence/baseline-npm-test.log`.
- `node scripts/static-check.js` — clean.
- `npm run build`, `npm run check:model`, `npm run pack:verify` — clean.

## Not executed here (honesty register)

- Installer double-click qualification on a clean Windows machine (no VM).
- Antivirus/SmartScreen behaviour of the unsigned build.
- External-database conformance paths (out of scope for the qualified 1.1.2
  Console target anyway).
