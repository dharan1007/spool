# Policy 09: Continuous Monitoring & Audit Logging Policy (SOC 2 CC7.2)

## 1. Objective
Establish technical standards for system observability, continuous monitoring, and immutable audit logging across all platform components.

## 2. Requirements
1. **Immutable Structured Audit Logging**:
   - Every administrative action, API call, migration state transition, and authentication event must be recorded in the WAL-journaled SQLite/PostgreSQL audit store (`src/daemon/audit-log.js`).
   - Audit records must include: `event_id`, `timestamp`, `principal`, `action`, `resource`, `outcome`, `detail_json`, `ip`.
   - Modifying or tampering with historical audit records is architecturally prevented (append-only schema).
2. **Audit Log Retention**:
   - Audit logs must be retained for a minimum of 365 days.
3. **Metrics & Probing**:
   - The platform must expose Prometheus-compatible metrics (`/v2/metrics`) capturing operational health, error counts, processing latencies, and lease acquisition metrics.
   - Kubernetes liveness (`/v2/health`) and readiness (`/v2/ready`) endpoints must continuously verify database connectivity and engine health.
