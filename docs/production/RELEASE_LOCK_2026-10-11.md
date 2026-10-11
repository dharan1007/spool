# SPOOL bounded production release contract — 2026-10-11

Status: **NOT RELEASE-AUTHORIZED**. Baseline main: `9acaf3de3a5d922c18a639dd3f5a8be0e5bf42db`. Work on a separate review branch; never alter main during qualification.

## Product lock
- **Browser Studio:** local-first CSV/XLSX input, first visible XLSX sheet, seven stages (original → inspect → understand → transform → dry-test → process → validate), JSON/CSV export, no dataset upload. Existing 50 MiB source-file ceiling is a *maximum in code*, not a memory/latency guarantee: qualify the cap on actual hardware or reduce it.
- **Local Runner:** UTF-8 filesystem CSV to an existing ordinary SQLite table using INSERT only; default maximum 256 MiB source, batch size 1–10,000. Approval, content-bound snapshot, path policy, target contract, fencing, atomic ledger, crash reconciliation, verification and receipt must all be qualified.
- **Optional:** browser WebMCP may expose state-valid kernel commands; availability must never be required for Studio.
- **Not in this production release:** PostgreSQL/MySQL/SQL Server targets, CDC, repair, cutover, bulk writes, live schema migration, managed data plane, full ETL connector ecosystem, enterprise SLAs, formal certification. Never silently offer experimental connectors through a production entrypoint.

## Mandatory ranked worklist
1. **P0 Source-input security:** guard XLSX sparse row indices *before allocation*, malformed/duplicate row and cell references, ZIP local/central metadata and paths, count actual decompressed bytes *during streaming*, enforce per-entry and aggregate limits, validate CRC, reject unsupported/encrypted/ZIP64 archives, add adversarial fixtures.
2. **P0 CSV/XLSX semantic fidelity:** validate Excel date systems, error cells, formula handling, first-visible/hidden sheets, header semantics, missing/duplicate cells, UTF-8 and malformed quotes. No silent data invention or row loss.
3. **P0 Execution qualification gate:** separate runtime assurance (C1/C4) from independently qualified production status; production CLI/service/spoold must reject experimental targets and unapproved mutation modes, with test-only explicit opt-in for disposable conformance.
4. **P0 Browser correctness:** all seven user-visible actions, explicit mapping approval, full dry-test revision binding, 95% preview threshold with rejected rows clearly accounted for, final validation, exports, invalid states, source replacement, no state/progress spoofing.
5. **P0 Browser durability:** IndexedDB quota/failure, reload, interrupted Worker, pause/resume, revision replay, no COMPLETE after failed persistence, no mixed source/output identity, CSP and no raw-row exfiltration.
6. **P0 SQLite correctness:** live preflight, triggered/virtual-table refusal, schema drift, INSERT only, positive source revalidation, approval signature/principal/expiry, atomic rows+ledger, conflicting evidence, SIGKILL at every persistence boundary, stale fencing, locked SQLite, WAL/disk capacity, exact row-and-ledger receipt.
7. **P0 Performance envelope:** constrained-memory streaming of >50 MiB CSV, real SQLite sustained load through the 256 MiB ceiling, browser CSV/XLSX peak-memory/latency measurements on actual supported devices, disk headroom preflight. Revise limits if not proved.
8. **P0 Actions-free release pipeline:** pin source SHA; `npm ci --ignore-scripts`, full Node suite (explicit PASS/FAIL/SKIP/TODO), required SQLite tests, dependency audit, static security, build, benchmarks, model check, packed installed CLI smoke, real Chrome built-artifact smoke, artifact-root parity, signature check where configured. A missing executable, database, browser or signing key cannot be treated as success for a required gate.
9. **P0 Exact deployment attestation:** deployed `release.json` SHA equals independently qualified build SHA; verify headers/route boot/CSP/export and browser smoke against live HTTPS. No deployment or rollback promotion solely on Vercel READY.
10. **P0 Public truth:** reconcile README, ROADMAP, docs/CAPABILITIES.md, docs/LIMITS.md, website and release notes with the machine-readable capability matrix. SQLite target is currently EXPERIMENTAL in the matrix; do not call it production without sustained-load qualification.
11. **P1 Operational product:** plain-language errors and next actions, reliable CLI install and PowerShell commands, source retention/backup/restore and recovery guide, incident/rollback instructions, support boundaries, secure secret handling.
12. **P1 Customer evidence:** synthetic realistic dirty-data corpora; controlled real-user UAT only after technical safety; distinguish adoption from implementation.

## Required verification sequence
- Read AGENTS.md, README, docs/ARCHITECTURE.md, docs/THREAT_MODEL.md, docs/PRODUCTION_AUDIT.md, docs/CAPABILITIES.md and docs/LIMITS.md.
- Reproduce P0 bugs with failing fixtures; patch minimal code; pass focused tests.
- Implement production-vs-experimental connector guard with changes to impacted conformance harnesses.
- Execute browser, SQLite correctness, crash and storage tests on disposable local systems. Preserve raw logs and resource evidence.
- Run one fail-closed offline qualification command (no GitHub Actions). Verify actual executed test counts and zero required skips.
- Package, install and verify exact SHA; only then assess deployment, run live Chrome smoke and create a release decision.

## Required commands (not a substitute for inspecting their results)
```sh
git status --porcelain
git rev-parse HEAD
node --version && npm --version
npm ci --ignore-scripts
npm test
npm run build
npm run benchmark
node scripts/static-check.js
npm run check
npm run pack:verify
python3 scripts/browser-smoke.py
```

## Evidence ledger / hard stops
For Browser CSV, Browser XLSX, Local SQLite, optional WebMCP, excluded remote targets, package, release provenance and deployed artifact, report: exact SHA, hardware/OS, command, test executed/failed/skipped counts, memory/disk/headroom, observed result, evidence location, and PASS/FAIL/NOT_EXECUTED. Do not label a surface production-ready if any required gate is FAIL or NOT_EXECUTED. No GitHub Actions. No claims of 100% without complete evidence.

## Agent budget instructions
One pass, no fresh architecture brainstorm, no speculative features, no CI-bypassing test deletion, no placeholders, no fake results, no direct changes to main. Use existing code/tests first. Preserve unfinished industrial branch. If blocked, stop after reviewed commits and produce exact remaining tasks and commands.
