# Cloudflare Pages rollout — source-bound, fail closed

Project: `spool-secure-staging`, account `b11965b1caa238976328848b27801ea8`.
Git source: private `dharan1007/spool`. Production branch: `main`.
Only `hardening/cloudflare-browser-boundary-20261015` has preview auto-builds; production pushes remain disabled until signed release approval. No GitHub Actions.

## Distribution boundary
- The web host serves *only browser-side* static application code.
- The Local Runner, PostgreSQL/MySQL/SQL Server connectors, daemon, platform signing and secrets handling remain local, not published as website JS.
- Data uploads/transforms remain in Browser Studio; `connect-src 'none'` denies outbound browser network requests. Do not add a backend data receiver or third-party telemetry.
- `_headers` is consumed by Cloudflare and is excluded from served-file artifact hashes, just like Vercel's `vercel.json`.
- SPOOL's immutably signed v1.1.2 release must remain unchanged and available for rollback.

## Web candidate build
After checking out the exact proposed commit on an authorized runner with Node 22 and supported Chromium:
```bash
npm ci
npm test
npm run check:model
SPOOL_COMMIT_SHA="$(git rev-parse HEAD)" npm run build
node scripts/check-static-distribution.js dist
python3 scripts/browser-smoke.py # local runner defaults to repository root; use SPOOL_SERVE_DIR=dist for candidate
```
Run Browser Studio CSV/XLSX, reload, export, error-path and privacy checks. Do not claim PostgreSQL/MySQL/SQL Server production qualification from this browser build.

## Preview HTTP acceptance
```bash
node scripts/verify-cloudflare-deployment.js https://<preview>.spool-secure-staging.pages.dev <exact-head-SHA>
python3 scripts/browser-smoke.py https://<preview>.spool-secure-staging.pages.dev
```
The verifier checks the SHA-bound manifest and **all** distributed artifact hashes, CSP/HTTPS headers, SPA deep links and absent privileged Node-source responses. Chrome smoke checks user actions, 25K sample rows and IndexedDB reload.

The Cloudflare build environment supplies `CF_PAGES_COMMIT_SHA`; static release metadata must reflect that exact SHA. Staging previews by themselves are **not** evidence of an independently signed production release.

## Promotion criteria
1. Mandatory full source SHA qualification passes on the supported Windows and database fixtures; attach original unmodified logs, fault proof, benchmarks and dependency audit.
2. Reproducible build/asset-root verification proves the build matches source, excluding host-consumed configs.
3. Authorized operator executes the existing release-signing process with their protected DPAPI-held signing key; never move private key to Pages or GitHub.
4. Independently verify signature, exact release SHA, manifest parity, staged HTTPS, Chrome Studio, fail-closed CSP and privilege-boundary HTTP tests.
5. Publish a **new immutable version** (v1.1.2 is immutable), merge the qualified source, then explicitly authorize production deployment of the exact signed artifact.
6. Reverify the production hostname, preserve working rollback and record launch evidence.

If Cloudflare build stalls: check dashboard Build logs and the 20-minute timeout; Free plan runs one build concurrently. Do not weaken tests or publish the current Vercel build under a different commit SHA.
