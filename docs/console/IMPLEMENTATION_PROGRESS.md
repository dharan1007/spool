# Implementation progress (durable)

Status: **RELEASE PREPARED** — application working, packaged and verified
locally; release management (merge/PR) is the only remaining human step.
Updated: 2026-10-23.

## Completed (verified)

| Area | State | Evidence |
| --- | --- | --- |
| Engine sync + release binding | byte-identical engine copy, manifest binds commit+aggregate hash | `scripts/console/sync-engine.mjs`, harness `verifyRelease` |
| Console service layer | orchestrator around `SpoolCommandService` with duplicate-run guard, source-unchanged enforcement, step ordering | `service/console-service.js` + 7/7 tests |
| IPC contract | zod strict schemas + dispatch table; unknown ops/extra fields fail closed | `service/contracts.js`, `ipc-router.js` |
| Electron security | sandbox, CSP no-connect, window/webview denial, DPAPI key store with marker pairing | `electron/*.js`, key-store tests in dev/packaged runs |
| Renderer wizard | 5-step journey wired to the production router bug-fixed (review triggers plan+dry-run) | screenshots + harness |
| Packaging | electron-builder win-unpacked, engine as extraResources, ABI-matched native module | `dist/package/win-unpacked` runs clean |
| Tests | full journey incl. tamper + duplicate-run + modified-source fails-closed | `apps/console/tests/*` |
| Docs | 19 substantive documents + machine-readable register | `docs/console/*` |
| Root suites | npm test (476 pass/64 skip), static-check, build, check-model, pack-verify | `.console-evidence/*.log` |

## Fixed during this release (real defects)

- `PRODUCTION_POLICY.matrixSha256` pinned the CRLF hash; corrected to the LF
  bytes (`fd7af7c0…`), verified against the checkout matrix.
- `evidence.js` `verifyBundle` used `require()` inside ESM — replaced with the
  proper ECMAScript import (evidence verification runs).
- `workspace-store.js` `updateMigrationPlan` overwrote the whole plan column
  (storing a dry-run erased the plan). Made all three columns `COALESCE`.
- Renderer review step jumped ahead without calling `createAndPlan`; fixed.
- Windows UTF-8 BOM pitfalls in dev scripts (Vite JSON parsing) removed.

## Known limitations (documented, fail-closed)

- Unsigned build: no installer; smart-screen warning expected (PACKAGING.md).
- `safeStorage` keys are context-bound; approvals do not survive app-context
  changes by design (WINDOWS_FIRST.md).
- Electron 45 unsupported until better-sqlite3 publishes ABI 150 or the
  machine repairs MSVC discovery (pinned 40.10.6 today).

## Not executed here (honesty register)

- Clean-machine install qualification, AV/SmartScreen behaviour, enterprise
  DPAPI policies (no VM) — TEST_PLAN.md honesty section.
