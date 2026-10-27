# RESUME — SPOOL production-hardening continuation

**Repo:** `C:\temp\spool-console` — branch `engineering/spool-enterprise-production-hardening`
**PR:** https://github.com/dharan1007/spool/pull/99 (base `38370a6`)
**Registers:** always read the other JSONs in this directory first; they are the source of truth. Do not rederive from session history.

## Current candidate

- Code commit verified by this batch: `d2c1b945725ae934115840c2faa2f23a9d363ac5`
- Pushed head that re-ran the full gate chain (`npm run check`):
  `e855353c50bb8cc37f615098fdee8822a493587f` (no `src/`, `capabilities/`,
  `package*.json` or `Dockerfile` difference from `d2c1b94`)
- Container image built from that exact tree: `spool-daemon:d2c1b94`,
  `sha256:5a7c62073ca9d0cfe5b8f72c70cddd472034b2ce3eaaa0568cd0804f0863b9ea`
- `npm run check` at `e855353`: 597 tests / 533 pass / 0 fail / 64 provider-gated
  skips; model check PASS; build + reproducible build `df77ec64…` (133
  artifacts, `reproducible: true`); static check PASS; then **`UNSIGNED_BUILD`**
  (exit 1, by design). Log: `E:\temp\spool-qual\npm-check-e855353.log`.
- Verdict: **NO-GO / EXTERNALLY BLOCKED** — only external material or host
  capacity remains (see `PRODUCTION_QUALIFICATION.md` and `BLOCKERS.json`).

## What is DONE and verified (do not redo)

1. **Container image (B005, was blocked):** builds, runs non-root (`node`,
   uid 1000), serves the real API, and passes **20/20** in-container acceptance
   checks (`scripts/qualify-container.js`): health/ready/metrics, 401/421/400,
   organization + workspace + API-key provisioning, real CSV → SQLite migration
   (plan → dry-run 5/5 → approve → execute `COMPLETE` → receipt → verification →
   5 durable rows). Restart keeps the migration `COMPLETE` and the rows intact;
   the listener is loopback-only (`/proc/net/tcp` `0100007F:1F90`, `ECONNREFUSED`
   on eth0); `/app` is not writable; `Privileged=false`, no `CapAdd`; missing
   token / bad commit / bad source ceiling each exit 1 with
   `INVALID_DAEMON_CONFIG`. Runbook: `docs/SELF_HOSTING.md`.
2. **PostgreSQL live qualification:** PostgreSQL 18.6, TLS `verify-full`,
   **55/55** conformance tests in 15 files (source, database source, target,
   content verification, metadata concurrency, schema migration, mutations,
   bulk COPY, repair, command source/recovery, reference recovery/soak, workers,
   CDC). Log: `E:\temp\spool-qual\pg-conformance-final.log`.
3. **MySQL live qualification:** MySQL 8.4.13, TLS `verify-full`, non-UTC host,
   **7/7** (repeatable on a database already carrying evidence). Log:
   `E:\temp\spool-qual\mysql-conformance-d2c1b94.log`.
4. **Two real connector defects fixed by live qualification:** PG 18 catalogues
   NOT NULL as `pg_constraint` (`contype='n'`) which blocked every constrained
   schema migration; MySQL `DATETIME` was parsed in the host timezone (IST
   shifted values by 5 h 30 m). Regressions in `tests/schema-migration.test.js`
   (11/11) and the live MySQL suite.
5. **Enterprise API v2 (7/7) including root-only `POST /v2/organizations`** —
   without it a fresh deployment could never create a workspace. Documented and
   covered (root allowed, API-key principal denied, org immediately usable).
6. **Full suite, build, benchmark, static check, model check, package verify,
   backup/restore drill, browser Studio 3×, Helm render:** see
   `PRODUCTION_QUALIFICATION.md` gate table (commit-labelled).
7. **Release gate fail-closed:** `UNSIGNED_BUILD` without signing material —
   verified design, not a defect (B003).
8. **Anchored facts:** `DEFAULT_MAX_SOURCE_BYTES = 256 MiB`; capability matrix
   pin `4915ac01…`; `spoold-v2` loopback-only + same-pod nginx proxy;
   `replicaCount: 1` + `Recreate`; helm objects 8, render sha `d073f5bb…`.

## Verification commands (order)

```powershell
cd C:\temp\spool-console
npm ci --ignore-scripts          # only if node_modules missing
$env:TEMP='E:\temp\spool-qual'; $env:TMP='E:\temp\spool-qual'
$env:SPOOL_BENCHMARK_OUTPUT_DIR='E:\temp\spool-qual\bench-check'
npm run check                    # last verified at e855353: 597/533/0/64sk/0, model PASS,
                                 # build+reproducible df77ec64… (133 artifacts), static PASS,
                                 # ends UNSIGNED_BUILD (exit 1) - that is the honest outcome
```

Live provider runs (containers `spool-pg`, `spool-mysql`, local CA at
`E:\temp\spool-qual\pg-certs\ca.crt`):

```powershell
$env:NODE_EXTRA_CA_CERTS='E:\temp\spool-qual\pg-certs\ca.crt'
$env:SPOOL_TEST_POSTGRES_ENDPOINT='postgres://127.0.0.1:55432?sslmode=verify-full'
$env:SPOOL_TEST_POSTGRES_DATABASE='spooltest'; $env:SPOOL_TEST_POSTGRES_USER='spooltest'
$env:SPOOL_TEST_PG_PASSWORD='spooltest-pg-secret-1'
node --test --test-concurrency=1 tests/conformance/postgres-*.test.js

$env:SPOOL_TEST_MYSQL_ENDPOINT='mysql://127.0.0.1:53306?sslmode=verify-full'
$env:SPOOL_TEST_MYSQL_DATABASE='spooltest'; $env:SPOOL_TEST_MYSQL_USER='spooltest'
$env:SPOOL_TEST_MYSQL_PASSWORD='mysql-secret-1'
node --test --test-concurrency=1 tests/conformance/mysql-*.test.js

docker build -t spool-daemon:local .
docker run -d --name spool-daemon-test -v spool-state:/var/lib/spool `
  -e SPOOL_DAEMON_TOKEN=<32+ bytes> -e SPOOL_APPROVAL_SIGNING_KEY=<32+ bytes> `
  -e SPOOL_RELEASE_COMMIT_SHA=$(git rev-parse HEAD) spool-daemon:local
docker cp scripts/qualify-container.js spool-daemon-test:/tmp/
docker exec -u node spool-daemon-test node /tmp/qualify-container.js
```

## What still stops the release (all external)

| Blocker | Missing | Label |
| --- | --- | --- |
| B001 | GCP service-account JSON for a BigQuery test project | `REAL_PROVIDER_NOT_QUALIFIED` |
| B002 | Host capacity for SQL Server 2022 (0.63 GB compressed / about 1.6 GB extracted vs **1.12 GB free on C:**; 34.90 GB docker disk effectively full, not compactable without elevation) | `REAL_PROVIDER_NOT_QUALIFIED` |
| B003 | Authorized release signing key | `UNSIGNED_BUILD` |
| B004 | Independent third-party audit | `NOT_AUDITED` |
| B006 | A Kubernetes cluster (Docker Desktop k8s disabled; enabling pulls control-plane images into the full C:) | `NOT_DEPLOYED` |
| B007 | Upstream `@azure/identity` release depending on `@azure/msal-node >= 7.1.0` (none published; 7.1.1 override proven API-incompatible) | `SECURITY_AUDIT_BLOCKED` |

Do not mark any of these passed. Do not lower the audit gate, do not suppress
the advisory, do not relocate/delete vhdx files by hand, and do not claim
multi-replica HA (coordination is not proven; the chart pins one writer).

## Next executable steps (only if new resources appear)

1. SQL Server available (or ≥4 GB free on the Docker drive): add
   `tests/conformance/mssql-*` live evidence exactly like the PG/MySQL runs
   (TLS verify-full, non-UTC host) and rerun `npm test`.
2. Certificates/cluster: `kubectl apply` the rendered chart, then run the
   daemon readiness + migration lifecycle in-cluster; record `K8S_DEPLOYED`
   with the real object list and pod evidence.
3. Signing key / GCP credentials / audit report: rerun the gate and replace the
   corresponding blocker with observed evidence.
4. Always: update registers, commit, push, verify SHA with `git ls-remote`.

## Environment notes

- PowerShell 5.1: no `&&`; ASCII only; commit messages from a BOM-less file.
- C: is effectively full (≈1.3 GiB). Keep `TEMP`/`TMP` and
  `SPOOL_QUALIFICATION_EVIDENCE_ROOT` on `E:`.
- Do not prune other projects' images (15.6 GB reclaimable belongs to
  supabase/nirnay). Only SPOOL-owned tags may be removed.
- Never run a qualification while editing tracked files; commit first, then run.
