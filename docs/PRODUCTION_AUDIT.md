# SPOOL Production Audit — 2026-09-04

## Rebuild goals

The production release is blocked unless the product is understandable without reading transform internals, the common migration can run with source + outcome only, the deterministic engine remains the single execution path, and the deployed browser boot path is ordinary and inspectable.

## Current release controls

- Route-driven product with dedicated Overview, Autopilot, How it works, WebMCP, Benchmarks, Docs and Studio surfaces.
- Browser Studio accepts CSV or XLSX source input; XLSX uses the first visible worksheet locally and never evaluates formulas.
- `run_autopilot` profiles, infers, plans, dry-runs and starts the existing Worker runtime without manual target/mapping commands.
- Ambiguous destructive decisions fail closed before execution.
- Full migration engine remains deterministic and arbitrary-code execution is prohibited.
- Target schemas are enforced per output row.
- IndexedDB stores durable source/output/mission/checkpoint state.
- Worker messages are job/revision/sequence scoped.
- Manual mapping revisions force replay from row zero rather than mixing output revisions.
- Autopilot refresh recovery creates a new Worker from the durable checkpoint; manual runs remain explicitly recoverable.
- Header-only replacement files are rejected before an active runtime is aborted.
- CSV export neutralizes spreadsheet formulas.
- WebMCP exposes only phase-valid tools and unregisters stale tools via AbortSignal.
- Failure or absence of the optional native WebMCP API does not prevent Studio from booting.
- UI, Autopilot and WebMCP all use the same command kernel.
- Production CSP keeps `connect-src 'none'` and uses no dataset network endpoint.
- The deployed application uses direct same-origin CSS/ES modules and a same-origin module Worker. No compressed payload reconstruction or dynamic blob application import sits in front of app startup.
- Vercel deep links use one SPA rewrite to `/index.html`; `cleanUrls` is intentionally disabled.
- Automated unit, integration, security, WebMCP, Autopilot, UI and build-contract tests must pass before deployment.
- Benchmarks publish measured—not invented—numbers.

## Known bounded limitations

- Current file selection is limited to 50 MiB and the source parser materializes normalized rows in browser memory. XLSX expanded content is capped at 256 MiB. 1 GB streaming/OPFS is not claimed in this release.
- Native WebMCP availability depends on the browser implementation.
- The release benchmark does not establish LLM completion-rate improvement; that requires a controlled flat-vs-temporal agent evaluation.
- Browser storage quota varies by device/browser.

## Deployment verification gate

After production deployment, verify:

1. `/` serves the direct same-origin module shell and security headers.
2. `/styles.css`, `/src/app.js`, Autopilot/kernel modules and the Worker return 200 with correct content types.
3. Every public/Studio deep route returns the SPA shell instead of 404.
4. Production runtime error clusters are empty for the release window.
5. A browser smoke run is attempted against the canonical HTTPS URL; if the execution environment blocks browser networking, report that limitation rather than fabricating a pass.

## Enterprise hardening audit — 2026-10-27

Branch `engineering/spool-enterprise-production-hardening` (PR #99) was rebuilt around a real command-bound enterprise surface and re-verified end to end. Candidate verdict and the full gate table live in `engineering/completion/PRODUCTION_QUALIFICATION.md`; the short version is **not production ready**, blocked only by named missing external material.

### Delivered and verified in this environment

- **Enterprise REST API v2** bound to the real `SpoolCommandService` through the registry and orchestrator: multi-tenant organisations, workspaces, memberships, API keys stored as SHA-256 digests, role-based authorization, per-principal sliding-window rate limiting, audit activity, and a full migration lifecycle with idempotent replay and verified target rows. Cross-workspace access fails closed with `MIGRATION_NOT_FOUND` so record existence does not leak. A fresh deployment can provision its own organization through root-only `POST /v2/organizations`, so a new install is not dependent on out-of-band registry access. `tests/api-v2.test.js` 7/7, plus `scripts/qualify-container.js` drives the same lifecycle over HTTP inside the built container.
- **Production daemon** `src/daemon/spoold-v2-main.js`: configuration only from the environment (token, signing key and 40-hex release commit are mandatory), source ceiling capped by `PRODUCTION_POLICY`, loopback binding with foreign `Host` rejection, graceful `SIGTERM`/`SIGINT`. `tests/daemon-entrypoint.test.js` 3/3.
- **Scheduler**: the auto-approve/execute `scheduleInterval` path is deleted; scheduling only stages, and staging requires a durable expiring lease whose takeover needs a strictly newer fencing token (`tests/scheduler.test.js`, `tests/scheduler-distributed-lease.test.js`).
- **Packaging**: multi-stage `Dockerfile` (non-root, read-only-rootfs friendly) and a rebuilt `helm/spool` chart with a same-pod `nginx-unprivileged` sidecar that rewrites `Host` for the loopback-only daemon, hardened pod security, Secret-only credentials, NetworkPolicy both directions, `values.schema.json`, and hard fail-closed guards for a missing release commit and for `replicaCount > 1` (single-writer SQLite state). Render verified with checksum-verified helm 3.16.4; 8 objects; both guards proven. Image build and cluster apply are not executed here (B005, B006).
- **Recovery**: online WAL backup of the open enterprise registry and target with full restore parity and tamper rejection (`scripts/drill-backup-restore.js` 12 checks, `tests/backup-restore.test.js` 4/4); runbook in `docs/BACKUP_AND_RESTORE.md`.
- **Qualification evidence**: qualification failures can no longer be masked by evidence-reading errors (`src/platform/measurement-evidence.js`); benchmark evidence now honours `SPOOL_BENCHMARK_OUTPUT_DIR` so a release qualification does not rewrite tracked files and report itself as source drift.
- **SQLite production qualification**: 20 fault/privacy cases and 262 599 assertions pass for the qualified commit, including kill/restart at three points, source/principal drift, nonce/effects/signature tampering, schema drift, WAL busy, stale fence, bounded/full/cap+1 and active concurrent takeover.
- **Browser Studio**: three consecutive real-Chrome smoke runs over the built `dist` cover all routes, a 25 000-row explicit seven-stage migration and the WebMCP tool surface, with zero runtime exceptions and zero failed network loads. One render race in the smoke script itself was fixed at its cause.
- **Threat model** extended to the enterprise registry/API/orchestrator surface (`docs/THREAT_MODEL.md`) with residual risks stated, and a dependency risk register added (`docs/DEPENDENCY_RISK.md`).

### Blocking qualifications

`B001` BigQuery real-provider credentials, `B002` PostgreSQL/MySQL/SQL Server endpoints, `B003` release signing material (`UNSIGNED_BUILD`), `B004` independent audit, `B005` Docker engine, `B006` Kubernetes cluster, `B007` high-severity transitive `@azure/msal-node` advisory with no compatible upstream fix. Details, exact missing resources and honest labels are in `engineering/completion/BLOCKERS.json`. None of these were worked around: the release gate, the dependency audit and the provider-gated suites all fail closed.
