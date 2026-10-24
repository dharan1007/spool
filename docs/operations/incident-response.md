# SPOOL Enterprise — Incident Response Runbook

## 1. Severity Classifications

| Severity | Definition | Examples | Response Target |
|---|---|---|---|
| **SEV-1 (Critical)** | Data corruption, split-brain write, compromise of approval signing keys | Fencing failure in multi-worker cluster, invalid receipt issued | < 1 hour |
| **SEV-2 (High)** | Service unavailable, migration crash loop, API gateway failure | `spoold-v2` crash, deadlock in target database | < 4 hours |
| **SEV-3 (Moderate)** | Non-blocking connector defect, minor UI/CLI rendering anomaly | Ambiguous warning parsing, metric scrape timeout | < 24 hours |
| **SEV-4 (Low)** | Documentation or cosmetic defect | Stale dashboard label | < 3 business days |

## 2. Response Procedures

### Phase 1: Detection & Triage
- Incident identified via Prometheus alert (`spool_migrations_total{status="FAILED"}` spike) or operator alert.
- Incident Commander assigned; incident channel opened.

### Phase 2: Containment
- **Fencing revocation**: Immediately expire or bump active lease tokens to halt rogue workers:
  ```sql
  UPDATE spool_execution_leases SET expires_at_ms = 0 WHERE resource = '<migration_id>';
  ```
- **API revocation**: Revoke suspect API keys via API key endpoint or direct DB invalidate.

### Phase 3: Investigation & Remediation
- Examine immutable audit log:
  ```js
  audit.query({ resource: '<migration_id>', from: '<iso>' });
  ```
- Inspect durable state machine transitions in `state.db`.
- Execute recovery decision: `svc.restartDecision(migrationId)`.

### Phase 4: Verification & Post-Mortem
- Run exact content verification against the target table.
- File root-cause analysis (RCA) within 72 hours.
