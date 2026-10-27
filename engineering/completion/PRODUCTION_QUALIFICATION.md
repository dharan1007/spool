# SPOOL production qualification — 2026-10-27 (update 2)

Candidate: branch `engineering/spool-enterprise-production-hardening` (PR #99),
package version `1.1.2`. Every verification run in this update was executed on
code commit `d2c1b945725ae934115840c2faa2f23a9d363ac5`, and the container image
was built from exactly that tree. The commit that carries this file additionally
contains register/documentation updates, regenerated API-layer benchmark output,
and one change confined to a provider-gated MySQL conformance test (its 7 tests
are skipped in the full-suite configuration, so no executed test path differs).
The tested code commit is the one named above.

## Verdict

**NO-GO / EXTERNALLY BLOCKED.** Every gate that can be exercised on this host
was executed and either passed or failed closed for a named reason. Nothing is
claimed that was not observed.

Resolved in this update (were blockers before):

- **B005 container image** — the image now builds, runs, serves the real API,
  performs a real CSV → SQLite migration through the canonical command path,
  survives a restart with intact state, binds loopback only, runs non-root and
  fails closed on misconfiguration.
- **PostgreSQL connector** — live conformance against a real PostgreSQL 18.6
  server with TLS `verify-full`: **55/55 tests pass**.
- **MySQL connector** — live conformance against a real MySQL 8.4.13 server with
  TLS `verify-full` on a non-UTC host: **7/7 tests pass**.

Remaining blockers, each with the exact missing resource:

| Blocker | Domain | Missing resource | Honest label |
| --- | --- | --- | --- |
| B001 | BigQuery real provider | GCP service-account JSON authorized for a BigQuery test project | `REAL_PROVIDER_NOT_QUALIFIED` |
| B002a | SQL Server live provider | Host capacity: the SQL Server 2022 image is 0.63 GB compressed / ≈1.6 GB extracted and needs a writable data volume, against **1.37 GB free on C:** holding a 34 GB Docker data disk that cannot be compacted without elevation (see "Host capacity") | `REAL_PROVIDER_NOT_QUALIFIED` (capacity, not product) |
| B003 | Signed release provenance | Authorized `SPOOL_RELEASE_PRIVATE_KEY` + enrolled public key | `UNSIGNED_BUILD` |
| B004 | Independent security audit | Third-party audit engagement | `NOT_AUDITED` |
| B006 | Cluster deployment | A Kubernetes cluster. Docker Desktop's own cluster is `disabled`; enabling it downloads control-plane images (`kindest/node` alone is 0.38 GB compressed) into the same full C: drive, so it was not attempted | `NOT_DEPLOYED` |
| B007 | Dependency advisory | Upstream `@azure/identity` release depending on `@azure/msal-node >= 7.1.0`; none exists (4.13.2 → `^5.1.5`, 4.14.0 → `^6.0.0`, latest is 4.14.0) | `SECURITY_AUDIT_BLOCKED` |

Every remaining blocker is either external material (credentials, signing keys,
audit) or host capacity that cannot be provisioned safely on this machine.

## Executed gates

| # | Gate | Command | Result |
| --- | --- | --- | --- |
| 1 | Pinned install | `npm ci --ignore-scripts` | PASS, 282 production packages |
| 2 | Dependency audit (high/critical) | `npm audit --omit=dev --audit-level=high` | **FAIL** — 2 high findings, both GHSA-xcx6-jx8p-x3h5 (`@azure/msal-node@5.6.0` via `@azure/identity@4.13.2`), B007 |
| 3 | Full suite | `node --test --test-reporter=tap --test-concurrency=1 tests/*.test.js tests/conformance/*.test.js` | **PASS** — 597 tests, 533 pass, 0 fail, 64 provider-gated skips, 0 todo, 0 cancelled (690 s). Log: `E:\temp\spool-qual\full-suite-d2c1b94.log` |
| 4 | Required SQLite suite | `node --test --test-concurrency=1 tests/sqlite-target …` | PASS — 30/30 at `06df51a` |
| 5 | SQLite production qualifier | `node scripts/qualify-sqlite-production.js` | PASS at `30565b1` — 20 cases, 262 599 assertions, 1 379 resource samples, 0 measurement errors |
| 6 | Build | `npm run build` | PASS — dist artifact root `bf9cbbf6…`, commit-bound |
| 7 | Reproducible build | release gate (two independent builds) | PASS — identical artifact root `bf9cbbf6404297b33134a838fd9419f6b6c559b94ddf1e28ff5e556b44fefae4`, 133 artifacts |
| 8 | Benchmark | `npm run benchmark` | PASS — evidence in `benchmarks/latest.json` and `docs/BENCHMARKS.md` |
| 9 | Static release check | `node scripts/static-check.js` | PASS — 21 required artifacts, stable SQLite runtime, no source-network primitives |
| 10 | Model check | `node scripts/check-svmp-model.js` | PASS — counterexample detection |
| 11 | Package verification | `npm run pack:verify` | PASS — installed-package run reproduces the qualified behaviour |
| 12 | Release chain | `node scripts/release-gate.js` | **FAIL CLOSED** `UNSIGNED_BUILD` (exit 1) — B003 |
| 13 | Browser Studio E2E | `python scripts/browser-smoke.py` (real Chrome, `dist`) | PASS — 3 consecutive full runs: 6 routes, 25 000-row seven-stage run, WebMCP surface, 0 runtime exceptions, 0 failed network loads |
| 14 | Backup/restore drill | `node scripts/drill-backup-restore.js` | PASS — 12 checks, restore parity, tampered backup rejected |
| 15 | Container image build | `docker build -t spool-daemon:d2c1b94 .` (engine 29.8.2) | **PASS** — exit 0, image `sha256:5a7c62073ca9d0cfe5b8f72c70cddd472034b2ce3eaaa0568cd0804f0863b9ea`, 532 642 879 B, `User=node`, entrypoint `node src/daemon/spoold-v2-main.js`, HEALTHCHECK present. Log: `E:\temp\spool-qual\docker-build-d2c1b94.log` |
| 16 | Container runtime acceptance | `docker exec -u node … node /tmp/qualify-container.js` (`scripts/qualify-container.js`) | **PASS** — 20 checks: `/v2/health` 200, `/v2/ready` 200, Prometheus metrics, unauthenticated 401, foreign-Host 421, invalid JSON 400, organization/workspace/API-key provisioning, migration create, execute-before-approval 422, plan, dry-run 5/5 rows, approve, execute `COMPLETE`, plan-bound receipt, verification, 5 durable target rows with exact values. Evidence: `E:\temp\spool-qual\container-acceptance-d2c1b94.json` |
| 17 | Container restart persistence | `docker restart` then re-query | **PASS** — migration still `COMPLETE` (200), 5 rows still readable after restart; volume-backed state |
| 18 | Loopback-only binding | `docker exec … fetch(http://<eth0>:8080/v2/health)` and `/proc/net/tcp` | **PASS** — `ECONNREFUSED` on the non-loopback interface; the only listener is `0100007F:1F90` (127.0.0.1:8080) |
| 19 | Container security posture | `docker inspect` / in-container probes | **PASS** — `User=node` (uid 1000), `/app` root-owned and not writable by the runtime user, `Privileged=false`, no added capabilities, healthy status |
| 20 | Container fail-closed config | `docker run` without token / bad commit / bad source ceiling | **PASS** — all three exit 1 with `INVALID_DAEMON_CONFIG` |
| 21 | PostgreSQL live conformance | 15 conformance files, `--test-concurrency=1`, PostgreSQL 18.6, `sslmode=verify-full` | **PASS — 55/55**, 0 fail, 0 skipped (source, database source, target, content verification, metadata concurrency, schema migration, mutations, bulk COPY, repair, command source/recovery, reference recovery/soak, workers, CDC). Log: `E:\temp\spool-qual\pg-conformance-final.log` |
| 22 | MySQL live conformance | `mysql-source-conformance` + `mysql-target-conformance`, MySQL 8.4.13, `sslmode=verify-full`, non-UTC host | **PASS — 7/7**, 0 fail, 0 skipped, repeated against a database that already carried evidence from earlier runs. Log: `E:\temp\spool-qual\mysql-conformance-d2c1b94.log` |
| 23 | Deployment render | `node scripts/check-deployment.js` (helm 3.16.4) | PASS — lint clean, 8 objects, fail-closed paths proven for missing release commit and `replicaCount > 1` |
| 24 | Capability matrix | `tests/capability-matrix.test.js` + pinned digest | PASS — 6/6, policy pin `4915ac01…` |

Scope note for gates 4–8 and 13–14: those runs belong to the earlier candidate
`06df51a` (SQLite qualifier at `30565b1`); the sources they exercise are
byte-identical to the current candidate except for the two connector fixes and
the new root-only organization route, neither of which is on the SQLite
migration path or the browser surface. They are labelled with their commit
rather than presented as re-runs on `d2c1b94`. The gates that exercise changed
code (full suite, container acceptance, PostgreSQL, MySQL) were re-run on
`d2c1b94`.

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
npm test                     # 597 tests, 533 pass, 0 fail, 64 provider-gated skips
node scripts/static-check.js
npm run build
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
