# SPOOL production qualification — 2026-10-28 (update 3)

Candidate: branch `engineering/spool-enterprise-production-hardening` (PR #99),
package version `1.1.2`.

## Verdict

**NO-GO — EXTERNALLY BLOCKED, with two gates additionally blocked by host
execution capacity.** Every gate that can be exercised on this host was executed
and either passed or failed closed for a named reason. Nothing is claimed that
was not observed.

Three blockers need material that does not exist on this machine (GCP credentials,
a release signing key, an independent audit).
Two need infrastructure this machine cannot hold (SQL Server's image and a
Kubernetes control plane): those are execution-capacity limits, recorded with
measured numbers, and are not product defects — they are also not passes.

Resolved (were blockers before):

- **B007 dependency advisory (resolved R007)** — Scoped optional connector drivers
  (`mssql`, `snowflake-sdk`) to `devDependencies` with runtime lazy-loading,
  driver shape and major version checking, and fail-closed typed error envelopes
  (`src/connectors/driver-loader.js`). The core production dependency set
  (`npm audit --omit=dev --audit-level=high`) now reports **0 vulnerabilities**.
- **B005 container image (resolved R005)** — the image now builds, runs, serves the real API,
  performs a real CSV → SQLite migration through the canonical command path,
  survives a restart with intact state, binds loopback only, runs non-root and
  fails closed on misconfiguration.
- **PostgreSQL connector (resolved R003)** — live conformance against a real PostgreSQL 18.6
  server with TLS `verify-full`: **55/55 tests pass**.
- **MySQL connector (resolved R004)** — live conformance against a real MySQL 8.4.13 server with
  TLS `verify-full` on a non-UTC host: **7/7 tests pass**.

Remaining blockers, each with the exact missing resource:

| Blocker | Domain | Missing resource | Honest label |
| --- | --- | --- | --- |
| B001 | BigQuery real provider | GCP service-account JSON authorized for a BigQuery test project | `REAL_PROVIDER_NOT_QUALIFIED` |
| B002 | SQL Server live provider | Host capacity: SQL Server 2022 is 0.63 GB compressed / ≈1.6 GB extracted plus a data volume, against **1.12 GB free on C:** and an essentially full 34.90 GB Docker data disk (<0.6 GB SPOOL-owned reclaimable; rest belongs to other projects). Docker data relocation runbook prepared in `CAPACITY_RELOCATION.md` (requires host owner GUI action) | `REAL_PROVIDER_NOT_QUALIFIED` (capacity, not product) |
| B003 | Signed release provenance | Authorized `SPOOL_RELEASE_PRIVATE_KEY` + enrolled public key | `UNSIGNED_BUILD` |
| B004 | Independent security audit | Third-party audit engagement. Internal security hardening completed (cloud-http timeouts, 32MB response ceiling, URL credentials rejection, SSRF/cloud metadata IP protection; `tests/cloud-http-security.test.js` 5/5 pass) | `NOT_AUDITED` |
| B006 | Cluster deployment | A Kubernetes cluster. Docker Desktop's own cluster is `disabled`; enabling it downloads control-plane images (`kindest/node` alone is 0.38 GB compressed) into the same full C: drive | `NOT_DEPLOYED` |

Every remaining blocker is either external material (credentials, signing keys,
audit) or host capacity that cannot be provisioned safely on this machine without
host owner action.

## Executed gates

| # | Gate | Command | Result |
| --- | --- | --- | --- |
| 1 | Pinned install | `npm ci --ignore-scripts` | PASS, 282 production packages |
| 2 | Dependency audit (high/critical) | `npm audit --omit=dev --audit-level=high` | **PASS** — 0 vulnerabilities (B007 resolved via lazy driver loader; DR-001/DR-002) |
| 3 | Full suite | `node --test --test-reporter=tap --test-concurrency=1 tests/*.test.js tests/conformance/*.test.js` | **PASS** — 597 tests, 533 pass, 0 fail, 64 provider-gated skips, 0 todo, 0 cancelled (690 s). Log: `E:\temp\spool-qual\full-suite-d2c1b94.log` |
| 4 | Required SQLite suite | `node --test --test-concurrency=1 tests/sqlite-target …` | PASS — 30/30 at `06df51a` |
| 5 | SQLite production qualifier | `node scripts/qualify-sqlite-production.js` | PASS at `30565b1` — 20 cases, 262 599 assertions, 1 379 resource samples, 0 measurement errors |
| 6 | Build | `npm run build` (inside `npm run check` at `e855353`) | **PASS** — dist artifact root `df77ec64…`, 133 artifacts, commit bound to `e855353c50bb8cc37f615098fdee8822a493587f` |
| 7 | Reproducible build | release gate (two independent builds at `e855353`) | **PASS** — both builds `df77ec64ff822f29dbc97dc82c1973210babdc47b561de1281ea2b36ae5f25cd`, 133 artifacts, `reproducible: true`, node v22.23.2, package-lock `f0589f22…` |
| 8 | Benchmark | `npm run benchmark` (inside `npm run check`) | **PASS** — evidence written to `E:\temp\spool-qual\bench-check\results\SPOOL-Bench\2026-10-27T14-19-58-819Z` (`SPOOL_BENCHMARK_OUTPUT_DIR`, so the in-repo copies were not rewritten and the tree stayed clean) |
| 9 | Static release check | `node scripts/static-check.js` | PASS — 21 required artifacts, stable SQLite runtime, no source-network primitives |
| 10 | Model check | `node scripts/check-svmp-model.js` (inside `npm run check` at `e855353`) | **PASS** — exhaustive SVMP exploration plus intentional-unsafe and stale-writer counterexamples (tests 532–536 in the same run) |
| 11 | Package verification | `npm run pack:verify` | PASS at `06df51a` — installed-package run reproduces the qualified behaviour |
| 12 | Release chain | `node scripts/release-gate.js` (inside `npm run check` at `e855353`) | **FAIL CLOSED** `UNSIGNED_BUILD` (exit 1) after binding SHA and both reproducible builds — B003 |
| 13 | Browser Studio E2E | `python scripts/browser-smoke.py` (`SPOOL_SERVE_DIR=dist`, `SPOOL_BROWSER=…chrome.exe`) | **PASS** — 3 consecutive full runs at `06df51a` and a re-run at `e855353` against the `dist` built from that commit (artifact root `df77ec64…`): 6 routes, 25 000-row seven-stage run (24 955 valid / 45 invalid, phase `COMPLETE`), WebMCP tool surface, recovery `PASS`, explicit Studio workflow `PASS`, 0 runtime exceptions, 0 failed network loads. Log: `E:\temp\spool-qual\browser-smoke-e855353.log` |
| 14 | Backup/restore drill | `node scripts/drill-backup-restore.js` | PASS — 12 checks, restore parity, tampered backup rejected |
| 15 | Container image build | `docker build -t spool-daemon:d2c1b94 .` (engine 29.8.2) | **PASS** — exit 0, image `sha256:5a7c62073ca9d0cfe5b8f72c70cddd472034b2ce3eaaa0568cd0804f0863b9ea`, 532 642 879 B, `User=node`, entrypoint `node src/daemon/spoold-v2-main.js`, HEALTHCHECK present. Log: `E:\temp\spool-qual\docker-build-d2c1b94.log`. `git diff d2c1b94..e855353` touches no `src/`, `capabilities/`, `package*.json` or `Dockerfile` file, so this image is still the candidate's executable content |
| 16 | Container runtime acceptance | `docker exec -u node … node /tmp/qualify-container.js` (`scripts/qualify-container.js`) | **PASS** — 20 checks: `/v2/health` 200, `/v2/ready` 200, Prometheus metrics, unauthenticated 401, foreign-Host 421, invalid JSON 400, organization/workspace/API-key provisioning, migration create, execute-before-approval 422, plan, dry-run 5/5 rows, approve, execute `COMPLETE`, plan-bound receipt, verification, 5 durable target rows with exact values. Evidence: `E:\temp\spool-qual\container-acceptance-d2c1b94.json` |
| 17 | Container restart persistence | `docker restart` then re-query | **PASS** — migration still `COMPLETE` (200), 5 rows still readable after restart; volume-backed state |
| 18 | Loopback-only binding | `docker exec … fetch(http://<eth0>:8080/v2/health)` and `/proc/net/tcp` | **PASS** — `ECONNREFUSED` on the non-loopback interface; the only listener is `0100007F:1F90` (127.0.0.1:8080) |
| 19 | Container security posture | `docker inspect` / in-container probes | **PASS** — `User=node` (uid 1000), `/app` root-owned and not writable by the runtime user, `Privileged=false`, no added capabilities, healthy status |
| 20 | Container fail-closed config | `docker run` without token / bad commit / bad source ceiling | **PASS** — all three exit 1 with `INVALID_DAEMON_CONFIG` |
| 21 | PostgreSQL live conformance | 15 conformance files, `--test-concurrency=1`, PostgreSQL 18.6, `sslmode=verify-full` | **PASS — 55/55**, 0 fail, 0 skipped (source, database source, target, content verification, metadata concurrency, schema migration, mutations, bulk COPY, repair, command source/recovery, reference recovery/soak, workers, CDC). Log: `E:\temp\spool-qual\pg-conformance-final.log` |
| 22 | MySQL live conformance | `mysql-source-conformance` + `mysql-target-conformance`, MySQL 8.4.13, `sslmode=verify-full`, non-UTC host | **PASS — 7/7**, 0 fail, 0 skipped, repeated against a database that already carried evidence from earlier runs. Log: `E:\temp\spool-qual\mysql-conformance-d2c1b94.log` |
| 23 | Deployment render | `node scripts/check-deployment.js` (helm 3.16.4) | PASS — lint clean, 8 objects, fail-closed paths proven for missing release commit and `replicaCount > 1` |
| 24 | Capability matrix | `tests/capability-matrix.test.js` + pinned digest | PASS — 6/6, policy pin `4915ac01…` |

Scope of the commit labels: gates 3, 6, 7, 8, 10, 12, 13 and 21–22 were executed on
the code commit (`d2c1b94`) or on the pushed evidence head (`e855353`), where the
only difference from `d2c1b94` is docs/registers, regenerated API-layer benchmark
output and a provider-gated test file. Gates 4, 5, 11 and 14 were executed on the
earlier candidate `06df51a` (SQLite qualifier at `30565b1`) and are labelled with
that commit rather than presented as re-runs: they exercise the SQLite target
path, packaging and backup/restore, none of which the post-`06df51a` changes touch
(two connector fixes and the root-only organization route). `npm run check` at
`e855353` re-ran the full suite, build, benchmark, static check, model check and
both reproducible builds, and ended in the designed `UNSIGNED_BUILD` failure;
`git diff 06df51a..HEAD` is empty for `package.json`, `package-lock.json`, `helm/`,
`scripts/check-deployment.js`, the SQLite/engine paths and the deployment tests,
so those labels remain valid for the candidate.

## Defects found and fixed by live qualification

Both were found by running the real servers, not by unit tests:

1. **PostgreSQL 18 catalogued NOT NULL constraints.** PostgreSQL 18 stores
   NOT NULL constraints in `pg_constraint` (`contype = 'n'`). The
   schema-migration planner treated every non-primary constraint as an unmanaged
   object, so any PG 18 table with a `NOT NULL` column refused add-column,
   cast, drop and primary-key migrations with `UNMANAGED_CONSTRAINT`. NOT NULL
   is already part of the column contract, so it is skipped; genuine unmanaged
   constraints still block (live PG 18 schema-migration suite 5/5, unit
   regression test covers both directions).
2. **MySQL `DATETIME` host-timezone dependence.** `DATETIME` has no offset and
   `mysql2` parsed it in the host process timezone. On an IST host a stored
   `2026-03-01 05:06:07` was returned as `2026-02-28T23:36:07Z`, i.e. migrated
   values silently shifted by 5 h 30 m. The connector now pins `timezone: 'Z'`,
   so read and write interpretation is host-independent (proven by passing the
   live suite on a non-UTC host).

Repeating the MySQL suite against the same server then surfaced a third, smaller
defect: the target conformance reset dropped and recreated only the data table,
while the durable `spool_batch_ledger` and `spool_execution_leases` rows from the
previous run remained. The product correctly reported the replay as already
committed / a ledger mismatch, so the suite failed on its second run even though
nothing was wrong with the connector. The reset now clears the ledger rows and
lease rows that belong to that test table only; the suite passes 7/7 on a clean
server and on a server already carrying earlier evidence, with no assertion
weakened.

A third gap was closed in the product surface: a freshly deployed daemon had no
way to create the organization every workspace belongs to, so a new install
could never provision a usable workspace through the API. `POST
/v2/organizations` (platform root, registry required) now exists, is covered by
`tests/api-v2.test.js` (root allowed, API-key principal denied, organization
immediately usable), and is documented in `docs/SELF_HOSTING.md` together with
the container runbook.

## Host capacity (why two gates could not run)

Measured on this machine:

- C: free space: **1.12 GB**; Docker data disk `docker_data.vhdx`: 34.90 GB
  against a 64 GB ceiling, contents effectively full (`docker system df`:
  25.97 GB images of which 15.6 GB belongs to other projects, 2.061 GB
  containers of which 1.95 GB belongs to other projects, 2.26 GB volumes,
  3.435 GB build cache). Pruning SPOOL's own build cache recovered 453 MB and
  removed nothing that belongs to another project; after that, SPOOL-owned
  reclaimable space is well under 0.6 GB.
- Compaction of that vhdx needs an elevated `diskpart`/`Optimize-VHD`
  (this session is not elevated) and relocating it is a Docker Desktop
  GUI/admin operation; editing `settings-store.json` alone creates a *new*
  empty disk rather than moving existing images, and moving vhdx files by hand
  is explicitly out of bounds.
- SQL Server 2022 Linux image: 0.63 GB compressed, ≈1.6 GB extracted, plus a
  writable data volume — it cannot be pulled and run without filling the system
  drive (a previous fill is what destabilised the Docker engine earlier in this
  work).
- Docker Desktop Kubernetes is `Mode: kind`, `State: disabled`; enabling it
  downloads control-plane images (e.g. `kindest/node:v1.36.1`, 0.38 GB
  compressed) into the same drive.

Provisioning was therefore attempted at the environment level and cannot be done
safely here; both gates are recorded as capacity-blocked, separately from the
external-material blockers.

## What is qualified and what is not

- Capability matrix: 49 rows — 5 `PRODUCTION`, 22 `EXPERIMENTAL`, 9 `PLANNED`,
  13 `UNSUPPORTED`. A `PRODUCTION` row means the capability meets the repository
  production rule (implementation + integration + fault + security + load test
  + benchmark + documented limits); it does **not** mean this release candidate
  is signed, audited or deployed.
- Browser product, deterministic engine, SQLite target path, enterprise API
  surface (including the new organization route), backup/restore, packaging,
  Helm chart and the container image are verified by executed tests, drills and
  a real in-container migration.
- PostgreSQL and MySQL are functionally qualified against one real server each
  at the versions above. They remain `EXPERIMENTAL` rows in the register: the
  production rule also requires connector-level benchmarks and limits evidence,
  which were not re-produced here, and one live server is not a provider fleet.
- SQL Server, Snowflake, BigQuery, Oracle, Db2, Databricks, Redshift, Aurora and
  SAP HANA are not live-qualified; their rows stay `PLANNED`/`EXPERIMENTAL` with
  the exact missing resource recorded.
- No signed artifact, cluster deployment, independent audit or public-scale
  proof exists, and none is claimed.

## Reproduce

```powershell
npm ci --ignore-scripts
npm run check                # full suite + model + build + benchmark + static + reproducible build,
                             # then fails closed UNSIGNED_BUILD without signing keys (exit 1)
# or step by step:
npm test                     # 597 tests, 533 pass, 0 fail, 64 provider-gated skips
node scripts/static-check.js
npm run build                # artifact root df77ec64… for e855353, 133 artifacts
npm run benchmark
npm run pack:verify
node scripts/release-gate.js # fails closed UNSIGNED_BUILD without keys

# container
docker build -t spool-daemon:local .
docker run -d --name spool-daemon-test -v spool-state:/var/lib/spool \
  -e SPOOL_DAEMON_TOKEN=<32+ bytes> -e SPOOL_APPROVAL_SIGNING_KEY=<32+ bytes> \
  -e SPOOL_RELEASE_COMMIT_SHA=$(git rev-parse HEAD) spool-daemon:local
docker cp scripts/qualify-container.js spool-daemon-test:/tmp/
docker exec -u node spool-daemon-test node /tmp/qualify-container.js

# live PostgreSQL (18.x, TLS verify-full) and MySQL (8.4, TLS verify-full)
$env:SPOOL_TEST_POSTGRES_ENDPOINT='postgres://127.0.0.1:55432?sslmode=verify-full'
$env:SPOOL_TEST_PG_PASSWORD='<password>'
$env:SPOOL_TEST_MYSQL_ENDPOINT='mysql://127.0.0.1:53306?sslmode=verify-full'
$env:SPOOL_TEST_MYSQL_PASSWORD='<password>'
# NODE_EXTRA_CA_CERTS points at the test CA for both
node --test --test-concurrency=1 tests/conformance/postgres-*.test.js
node --test --test-concurrency=1 tests/conformance/mysql-*.test.js
```

Qualification fixtures on this machine must run with `TEMP`/`TMP` and
`SPOOL_QUALIFICATION_EVIDENCE_ROOT` on `E:`; the system drive has ~1.3 GiB free
against the mandatory 10 GiB preflight of the SQLite qualifier.
