# SPOOL production qualification — 2026-10-27

Candidate: branch `engineering/spool-enterprise-production-hardening` (PR #99),
package version `1.1.2`. The verification runs below were executed on commit
`06df51aadb6626124a21df313dbbf035b9e1a64d`; the register/evidence commit that
follows it changes documentation only.

## Verdict

**NOT PRODUCTION READY.** Every gate that can be exercised in this environment
was executed and either passed or failed closed for a named reason. The release
is blocked by seven recorded blockers (see below), two of which stop the release
pipeline itself: missing signing material (B003) and a high-severity transitive
dependency advisory with no compatible upstream fix (B007). No gate was lowered,
skipped or reinterpreted to reach a passing status.

This is the honest terminal state: the product is *engineering-complete for
every capability that is claimed*, not *release-qualified*.

## Executed gates

| # | Gate | Command | Result |
| --- | --- | --- | --- |
| 1 | Pinned install | `npm ci` | PASS, 282 production packages |
| 2 | Dependency audit (high/critical) | `npm audit --omit=dev --audit-level=high` | **FAIL** — 2 high findings, both GHSA-xcx6-jx8p-x3h5 (`@azure/msal-node@5.6.0`), B007 |
| 3 | Full suite | `npm test` | PASS — 595 tests: 531 pass, 0 fail, 0 cancelled, 64 provider-gated skips, 0 todo (652 s) |
| 4 | Required SQLite suite | `node --test --test-concurrency=1 tests/sqlite-target …` | PASS — 30/30 |
| 5 | SQLite production qualifier | `node scripts/qualify-sqlite-production.js` | PASS at `30565b1` — 20 cases, 262 599 assertions, 1379 resource samples, 0 measurement errors |
| 6 | Build | `npm run build` | PASS — dist artifact root `bf9cbbf6…`, commit-bound |
| 7 | Reproducible build | release gate (two independent builds) | PASS — identical artifact root `bf9cbbf6404297b33134a838fd9419f6b6c559b94ddf1e28ff5e556b44fefae4`, 133 artifacts |
| 8 | Benchmark | `npm run benchmark` | PASS — evidence in `benchmarks/latest.json` and `docs/BENCHMARKS.md` |
| 9 | Static release check | `node scripts/static-check.js` | PASS — 21 required artifacts, stable SQLite runtime, no source-network primitives |
| 10 | Model check | `node scripts/check-svmp-model.js` | PASS — counterexample detection |
| 11 | Package verification | `npm run pack:verify` | PASS — installed-package run reproduces the qualified behaviour |
| 12 | Release chain | `node scripts/release-gate.js` | **FAIL CLOSED** `UNSIGNED_BUILD` (exit 1) — B003 |
| 13 | Browser Studio E2E | `python scripts/browser-smoke.py` (real Chrome, `dist`) | PASS — 3 consecutive full runs: 6 routes, 25 000-row explicit seven-stage run, WebMCP tool surface, 0 runtime exceptions, 0 failed network loads |
| 14 | Backup/restore drill | `node scripts/drill-backup-restore.js` | PASS — 12 checks, restore parity, tampered backup rejected |
| 15 | Image build | `docker build` (engine 29.8.2) | **NOT EXECUTED** — daemon came up after a restart, served `docker images`/`system df`, then died mid `docker build --check`; host drive has 1.28 GB free vs a 34.15 GB Docker data vhdx, B005 |
| 16 | Deployment render | `node scripts/check-deployment.js` (helm 3.16.4) | PASS — lint clean, 8 objects, fail-closed paths proven for missing release commit and `replicaCount > 1` |
| 17 | Capability matrix | `tests/capability-matrix.test.js` + pinned digest | PASS — 6/6, policy pin `4915ac01…` |

Scope note for gate 5: the only `src/` change between the qualified commit
`30565b1` and `06df51a` is the new `src/platform/sqlite-backup.js`, which is not
on the migration path; the migration and SQLite connector sources are
byte-identical. The qualification is therefore applicable to this candidate,
but it is stated with that scope rather than as a re-run on the final SHA.

## Blocked qualifications (exact missing resource)

| Blocker | Domain | Missing resource | Honest label |
| --- | --- | --- | --- |
| B001 | BigQuery real provider | GCP service-account JSON for a BigQuery test project | REAL_PROVIDER_NOT_QUALIFIED |
| B002 | PostgreSQL / MySQL / SQL Server connectors | Live database endpoints with credentials (CDC/repair/cutover/soak) | REAL_PROVIDER_NOT_QUALIFIED |
| B003 | Signed release provenance | Authorized `SPOOL_RELEASE_PRIVATE_KEY` + enrolled public key | UNSIGNED_BUILD |
| B004 | Independent security audit | Third-party audit engagement | NOT_AUDITED |
| B005 | Container image | Stable Docker engine + host disk headroom (client 29.8.2 present; daemon starts then dies mid-build; 1.28 GB free on the drive holding the 34.15 GB Docker data vhdx) | IMAGE_NOT_BUILT |
| B006 | Cluster deployment | Reachable Kubernetes API server + helm on PATH | NOT_DEPLOYED |
| B007 | Dependency advisory | Upstream `@azure/identity` release depending on `@azure/msal-node >= 7.1.0` | SECURITY_AUDIT_BLOCKED |

B003 also blocks the bounded qualification runbook
(`scripts/qualify-bounded-release.js`), which stops earlier at B007
(`dependency_install` PASS, `security_audit` FAIL, `qualification.json`
`status: BLOCKED`, commit-bound to `6bedad3`).

## What is qualified and what is not

- Capability matrix: 49 rows — 5 `PRODUCTION`, 22 `EXPERIMENTAL`, 9 `PLANNED`,
  13 `UNSUPPORTED`. A `PRODUCTION` row means the capability meets the repository
  production rule (implementation + integration + fault + security + load test
  + benchmark + documented limits); it does **not** mean this release candidate
  is signed, audited, provider-qualified or deployed.
- The browser product, deterministic engine, SQLite target path, enterprise API
  surface, backup/restore, packaging and Helm chart are verified by executed
  tests and drills in this environment.
- `EXPERIMENTAL` connectors (PostgreSQL, MySQL, SQL Server, enterprise control
  plane) are not qualified against live providers.
- No signed artifact, container image, cluster deployment, real-provider
  migration, independent audit or public-scale proof exists, and none is
  claimed.

## Reproduce

```powershell
npm ci
npm test                     # 595 tests: 531 pass / 64 provider-gated skips
node scripts/static-check.js
npm run build
npm run benchmark
npm run pack:verify
node scripts/release-gate.js # fails closed UNSIGNED_BUILD without keys
node scripts/browser-smoke.py   # SPOOL_SERVE_DIR=dist, real Chrome
node scripts/drill-backup-restore.js
```

Qualification fixtures on this machine must run with `TEMP`/`TMP` and
`SPOOL_QUALIFICATION_EVIDENCE_ROOT` on `E:`; the system drive has ~1.3 GiB free
against the mandatory 10 GiB preflight of the SQLite qualifier.
