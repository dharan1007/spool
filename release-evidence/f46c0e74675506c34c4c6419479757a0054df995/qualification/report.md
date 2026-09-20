# SPOOL Industrial PostgreSQL Qualification

Run: spool-qualify-2026-09-20T07-26-45-892Z-3b4d1862
Profile: CI rows=100000 payload=256B batch=5000 writers=2 workers=2 cdc=30s (CI: minimal sustained load for PR gate (30s CDC))
Commit: f46c0e74675506c34c4c6419479757a0054df995
Dataset: sha256:adddd6aecc767d9903c0ade59ab987f78d7ae2cedc435bfc28f411e5216d1ed9
Seed: qualify-spool-qualify-2026-09-20T07-26-45-892Z-3b4d1862-CI
Environment: win32 x64 Node v22.23.2 PG 17.0 (Debian 17.0-1.pgdg110+1)
Duration: 427.5s
Result: **PASS**
Release grade: true

## Summary
- Scenarios: 9 (run: 9)
- Failures: 0 (expected refusals: 0, stubs: 0)
- Peak RSS: 423.1 MiB (ceiling 768 MiB)
- Throughput (target): 4001 rows/s

## Scenarios
- **postgres.target.load**: PASS
- **postgres.bulk.load**: PASS
- **postgres.content-exact.verification**: PASS
- **postgres.repair.load**: PASS
- **postgres.cdc.soak**: PASS
- **postgres.workers.load**: PASS
- **postgres.largeTransactions**: PASS
- **postgres.database-source.load**: PASS
- **postgres.crashRecovery**: PASS

## Failures
None

## Resource
- RSS initial: 98.3 MiB
- RSS peak: 423.1 MiB
- Heap median: 122.6 MiB

## Evidence
- Directory: qualification\spool-qualify-2026-09-20T07-26-45-892Z-3b4d1862
- Files: config.json, environment.json, failures.json, manifest.json, metrics.json, raw.jsonl, report.md

## Limits Observed
- Max CDC lag: n/a ms
- Verification throughput: 1548.4061771341828 rows/s
- Repair throughput: 2.0299431803070274 rows/s

> Generated at 2026-09-20T07:33:53.881Z by industrial-postgres qualification harness.
