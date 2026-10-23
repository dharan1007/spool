# SPOOL Console — Windows desktop application

SPOOL Console is the operator-facing desktop application for the qualified
SPOOL migration engine (release `1.1.2`). It packs the engine into an Electron
bundle and exposes the real command path — `SpoolCommandService` plan /
dry-run / approve / execute — through a validated IPC contract, a sandboxed
React renderer and native file dialogs.

The Console never re-implements engine behaviour: the engine sources are
copied byte-identically into `apps/console/engine/` by
`scripts/console/sync-engine.mjs`, bound to an exact git commit SHA through a
hash manifest, and verified at startup (`system.verifyRelease`).

## Qualified scope (first release)

| Dimension | Supported | Notes |
| --- | --- | --- |
| Source | UTF-8 CSV on local filesystem | 256 MiB byte ceiling from production policy |
| Target | existing ordinary SQLite table | INSERT-only, triggers/virtual tables refused |
| Write strategy | INSERT batches, 1..10 000 rows | no bulk COPY path |
| Verification | `row_accounting`, `ledger_complete` | content_exact unavailable on SQLite |
| Unsupported | PostgreSQL / MySQL / SQL Server, CDC, repair, cutover, destructive mutation | surfaced as NOT_AVAILABLE, never faked |

The authoritative policy lives in `src/platform/production-policy.js` and the
capability matrix in `capabilities/matrix.json`. The Console reads both from
the packaged engine and can therefore never drift from the release scope.

## Repository layout

```
apps/console/
  electron/   main process: window security, IPC registration, key store, dialogs
  preload/    CJS context bridge exposing exactly one validated invoke channel
  service/    privileged service layer (validated by contracts.js)
  renderer/   React UI (bundled with Vite; sandboxed, no node integration)
  engine/     byte-identical engine copy + hash manifest (generated)
  scripts/    harness.js (Electron-level IPC journey runner)
  tests/      node:test suites against the repo engine tree
scripts/console/sync-engine.mjs   engine bundle + manifest generator
docs/console/                     this documentation set
```

## Documentation map

- [ARCHITECTURE.md](ARCHITECTURE.md) — process model, data flow, trust boundaries
- [SECURITY.md](SECURITY.md) — threat-model deltas, key handling, renderer hardening
- [REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md) — requirement register, R1–R22
- [TEST_PLAN.md](TEST_PLAN.md) — what is covered and how to reproduce
- [USER_GUIDE.md](USER_GUIDE.md) — wizard walkthrough
- [PRODUCTION_GATES.md](PRODUCTION_GATES.md) — gates and honest status
- [PACKAGING.md](PACKAGING.md) — signed vs unsigned packaging decisions
- [WINDOWS_FIRST.md](WINDOWS_FIRST.md) — Windows-specific behaviour incl. safeStorage
- [WORKSPACE_MODEL.md](WORKSPACE_MODEL.md) — storage split, migration dirs
- [MAPPING_GUIDE.md](MAPPING_GUIDE.md) — allow-listed operators, boolean→integer pattern
- [APPROVAL_MODEL.md](APPROVAL_MODEL.md) — binding, expiry, key custody
- [RUN_MONITOR.md](RUN_MONITOR.md) — execution surfaces, recovery semantics
- [HISTORY_AND_RECEIPTS.md](HISTORY_AND_RECEIPTS.md) — history, receipts, exports
- [EVIDENCE_FORMAT.md](EVIDENCE_FORMAT.md) — bundle + manifest layout
- [EVIDENCE_REGISTER.md](EVIDENCE_REGISTER.md) — evidence files + reproduction
- [DIAGNOSTICS.md](DIAGNOSTICS.md) — support bundle contents and redaction
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — symptom → cause → remedy
- [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) — frozen inputs, build/verify order
- [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) — durable progress record
- [requirement-register.json](requirement-register.json) — machine-readable register

## Build and run

```powershell
cd apps/console
npm install          # keep --ignore-scripts off; electron needs its binary
npm test             # engine-coupled service tests
npm run typecheck
npm run start        # dev run (sync engine + vite build + electron .)
npm run package:dir  # packaged, unsigned, win-unpacked build
```

The desktop app requires no network, no accounts and no telemetry. The
packaged build is unsigned on purpose (no certificate in the release
environment); see PACKAGING.md before distributing it.
