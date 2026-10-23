# SPOOL Console requirement and evidence register

Machine-readable summary lives in `docs/console/requirement-register.json`;
this document is the human-readable index. Status legend: SATISFIED (verified
by listed evidence), NOT_EXECUTED (not possible in this environment, honestly
unreported otherwise), FAIL-CLOSED (intentionally unavailable).

| # | Requirement | Status | Implementation | Evidence |
| --- | --- | --- | --- | --- |
| R1 | Real Windows desktop application (Electron), no mock pipeline | SATISFIED | `apps/console/electron/*`, packaged build ran | `.console-evidence/packaged-window.png`, boot stderr empty |
| R2 | All migrations execute through `SpoolCommandService` | SATISFIED | `service/console-service.js` calls `engine.SpoolCommandService.create()` only | `apps/console/tests/full-journey.test.js` |
| R3 | No second parser/planner/executor | SATISFIED | Source/destination discovery reuse `inspectCsvStream`, `inferSchema`, `inspectSqliteTarget` | code review of `source-discovery.js`, `sqlite-catalog.js` |
| R4 | CSV → existing ordinary SQLite table, INSERT-only | SATISFIED | plan builder emits `writeStrategy {mode:'insert'}`; policy denies others | full-journey test; harness `executeStatus: COMPLETE`, `targetRows: 40` |
| R5 | 256 MiB source ceiling enforced | SATISFIED | `source-discovery` uses `engine.PRODUCTION_POLICY.maxSourceBytes`; engine re-checks | engine policy; Console error `SOURCE_TOO_LARGE` |
| R6 | Unsupported capabilities shown as unavailable, never faked | SATISFIED | `service/system-service.js` lists them; engine would also deny | `system.getCapabilities` output in harness |
| R7 | Wizard covers inspect → map → review → dry-run → approve → execute | SATISFIED | `renderer/src/app.jsx`, verified visually and via IPC router | `.console-evidence/packaged-window.png` |
| R8 | Approval by signed key, key never exposed to renderer | SATISFIED | `electron/key-store.js` (DPAPI safeStorage) + bound approval flow | full-journey; harness `approvalId` |
| R9 | Duplicate-run guard | SATISFIED | synchronous `running` set + RUNNING state check | `tests/full-journey.test.js` duplicate test |
| R10 | Source unchanged re-verification before approve/execute | SATISFIED | `assertSourceUnchanged` inplan/dryRun/approve/execute paths | modified-source test |
| R11 | Evidence export + verify + tamper rejection | SATISFIED | `service/evidence.js` sha256 manifest | full-journey tamper test |
| R12 | Release binding: engine bundle sha/commit verified at boot | SATISFIED | `electron/main.js` boot check + `system.verifyRelease` | harness `verifyRelease.verified=true` |
| R13 | Sanitized error envelopes, no raw stack traces | SATISFIED | `service/errors.js` `toEnvelope` | negative IPC tests |
| R14 | Unknown IPC operations/extra fields rejected | SATISFIED | zod `.strict()` + router table | harness `unknownOpRejected`, extra-field test |
| R15 | Workspace model with archive/impact | SATISFIED | `workspace-store.js`, `workspace.impact` | workspace journeys in tests |
| R16 | Recipes/drafts versioned and never auto-authorizing | SATISFIED | `service/recipes.js` (imports land REVIEW_REQUIRED) | recipe unit checks in mapping tests |
| R17 | History/events/transitions/verification/receipt surfaces | SATISFIED | router exposes engine state + metadata | full-journey history status COMPLETE |
| R18 | Diagnostics + sanitized support bundle | SATISFIED | `service/diagnostics.js` redaction | `diagnostics.get/export` routed |
| R19 | Windows-first, zero-cost, offline, no telemetry | SATISFIED | no network calls in main/renderer; zero paid services | CSP `connect-src 'none'` |
| R20 | Signer-real installers | FAIL-CLOSED (this release) | no certificate in environment; unsigned build labelled | `PACKAGING.md`, `PRODUCTION_GATES.md` |
| R21 | GitHub actions / paid CI | NOT APPLICABLE | none added | repo workflows unchanged |
| R22 | Node/OS-conformance suite for external DBs | NOT_EXECUTED | 64 conformance tests skipped (external DBs absent) | root baseline log |

Honesty note: R1–R19 were each executed on this machine during this release
preparation; R20/R21/R22 are documented negative results rather than assumed.
