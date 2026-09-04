# SPOOL Production Audit — 2026-09-04

## Rebuild goals

The production release is blocked unless the product is understandable without reading transform internals, the common migration can run with source + outcome only, the deterministic engine remains the single execution path, and the deployed browser boot path is ordinary and inspectable.

## Current release controls

- Route-driven product with dedicated Overview, Autopilot, How it works, WebMCP, Benchmarks, Docs and Studio surfaces.
- Default migration setup requires only a CSV source and desired outcome.
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

- Current file selection is limited to 50 MB and the source parser materializes CSV text/rows in browser memory. 1 GB streaming/OPFS is not claimed in this release.
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
