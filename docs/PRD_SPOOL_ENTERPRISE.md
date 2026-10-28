# SPOOL Enterprise — Product Requirements Document (PRD)

**Version**: 1.0.0  
**Status**: DRAFT  
**Author**: Engineering  
**Date**: 2026-10-23  
**Baseline**: SPOOL v1.1.2 (commit `497aa9b`)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Strategic Context & Market Position](#2-strategic-context)
3. [C4 Architecture Model](#3-c4-architecture)
4. [Phase Roadmap](#4-phase-roadmap)
5. [Architecture Decision Records (ADRs)](#5-adrs)
6. [Detailed Requirements by Phase](#6-detailed-requirements)
7. [Non-Functional Requirements](#7-nfr)
8. [Risk Register](#8-risk-register)
9. [Success Metrics](#9-success-metrics)
10. [Appendices](#10-appendices)

---

## 1. Executive Summary

### Vision
Transform SPOOL from a single-operator CSV→SQLite migration tool into the
**industry-leading verified data migration platform** — retaining its unique
correctness properties (cryptographic receipts, deterministic crash recovery,
fail-closed ambiguity, no arbitrary code execution) while scaling to enterprise
breadth, volume, and operational maturity.

### Current State (v1.1.2)
- **Production-qualified**: CSV → SQLite INSERT ≤256 MiB, single operator
- **Experimental**: PostgreSQL (source/target/CDC/bulk/repair/workers),
  MySQL (source/target), SQL Server (source/target)
- **Planned only**: Snowflake, BigQuery, Databricks, Redshift, Oracle
- **Missing**: RBAC, SSO, monitoring, scheduling, cloud hosting, compliance,
  horizontal scaling, API, multi-tenant

### Target State (v3.0)
- **Production-qualified**: CSV/PG/MySQL/MSSQL sources → SQLite/PG/MySQL/MSSQL/
  Snowflake/BigQuery targets, 10 GB+ sources, horizontal scaling
- **Enterprise**: RBAC, SSO/SAML, Prometheus metrics, Airflow/Temporal
  integration, SOC 2 Type II, cloud-hosted managed service
- **Market position**: The only migration platform that proves its migrations
  are correct with cryptographic evidence

### Unique Selling Proposition (unchanged, scaled)
> "Every migration produces a cryptographic receipt. Every crash recovers
> deterministically. Every ambiguity fails closed. Your data never leaves
> your infrastructure unless you choose our managed service."

---

## 2. Strategic Context & Market Position

### Target Market Segments

| Segment | Pain Point SPOOL Solves | Current Alternative | SPOOL Advantage |
|---|---|---|---|
| **Regulated industries** (finance, healthcare, government) | Proving migration correctness for auditors | Manual scripts + screenshots | Cryptographic receipts + SOC 2 |
| **Data engineering teams** | Silent data corruption in ETL pipelines | Fivetran/Airbyte (cloud) | Data sovereignty + fail-closed |
| **Database migration projects** | Crash recovery = restart from scratch | pgloader/DMS | Deterministic checkpoint recovery |
| **AI/ML data pipelines** | Dirty data silently entering training sets | Custom scripts | Type inference + violation surfacing |
| **Compliance-heavy orgs** | Audit trail for data movement | Manual logs | Machine-verifiable evidence chain |

### Competitive Differentiation Matrix

```
                        CORRECTNESS GUARANTEES
                               ▲
                     HIGH ─────┤
                               │     ┌─────────────┐
                               │     │ SPOOL v3.0  │  ← TARGET
                               │     │ (this PRD)  │
                               │     └─────────────┘
                               │
                     MED  ─────┤
                               │  ┌────────┐
                               │  │SPOOL   │ ← TODAY
                               │  │v1.1.2  │
                               │  └────────┘
                     LOW  ─────┤
                               │         ┌──────────┐  ┌─────────┐
                               │         │Fivetran  │  │AWS DMS  │
                               │         │Airbyte   │  │ADF      │
                               └─────────┴──────────┴──┴─────────┴────►
                              LOW        MED         HIGH
                                    SCALE / BREADTH
```

---

## 3. C4 Architecture Model

### Level 1: System Context

```
┌──────────────────────────────────────────────────────────────────────┐
│                        SPOOL Enterprise Platform                     │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ Console     │  │ CLI / SDK   │  │ REST API     │  │ Web Studio │ │
│  │ (Electron)  │  │ (npm pkg)   │  │ (spoold v2)  │  │ (Browser) │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘  └─────┬─────┘ │
│         │                │                │                 │       │
│         └────────────────┴────────┬───────┴─────────────────┘       │
│                                   │                                  │
│                    ┌──────────────▼──────────────┐                   │
│                    │    SpoolCommandService      │                   │
│                    │    (single command kernel)   │                   │
│                    └──────────────┬──────────────┘                   │
│                                   │                                  │
│         ┌─────────┬──────────┬────┴────┬──────────┬──────────┐      │
│         ▼         ▼          ▼         ▼          ▼          ▼      │
│    ┌─────────┐┌────────┐┌────────┐┌────────┐┌─────────┐┌────────┐  │
│    │CSV      ││SQLite  ││Postgres││MySQL   ││MSSQL    ││Cloud   │  │
│    │Source   ││Target  ││Src/Tgt ││Src/Tgt ││Src/Tgt  ││Targets │  │
│    └─────────┘└────────┘└────────┘└────────┘└─────────┘└────────┘  │
└──────────────────────────────────────────────────────────────────────┘
         │                                              │
         ▼                                              ▼
┌──────────────────┐                        ┌──────────────────────┐
│ Customer Data    │                        │ Observability Stack  │
│ (never leaves    │                        │ Prometheus / Grafana │
│  customer infra  │                        │ (opt-in metrics only)│
│  unless managed) │                        └──────────────────────┘
└──────────────────┘
         │                                              │
         ▼                                              ▼
┌──────────────────┐                        ┌──────────────────────┐
│ Identity Provider│                        │ Orchestration        │
│ Okta / Azure AD  │                        │ Airflow / Temporal   │
│ (SSO/SAML)       │                        │ (scheduling)         │
└──────────────────┘                        └──────────────────────┘
```

### Level 2: Container Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SPOOL Platform                                   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │                     API Gateway (spoold v2)                      │    │
│  │  • REST API (OpenAPI 3.1)                                       │    │
│  │  • Bearer token + API key + JWT (SSO) authentication            │    │
│  │  • Rate limiting, request validation                            │    │
│  │  • Prometheus /metrics endpoint                                 │    │
│  │  • WebSocket for real-time status                               │    │
│  └───────────────────────┬──────────────────────────────────────────┘    │
│                          │                                               │
│  ┌───────────────────────▼──────────────────────────────────────────┐    │
│  │                  Auth & RBAC Layer                                │    │
│  │  • API key management (create/revoke/rotate)                    │    │
│  │  • SAML 2.0 / OIDC federation (Okta, Azure AD, Google)         │    │
│  │  • Role-based access: admin, operator, viewer, api-client       │    │
│  │  • Per-workspace permission scoping                             │    │
│  │  • Audit log (immutable, queryable, retention-policy-bound)     │    │
│  └───────────────────────┬──────────────────────────────────────────┘    │
│                          │                                               │
│  ┌───────────────────────▼──────────────────────────────────────────┐    │
│  │              SpoolCommandService (unchanged kernel)               │    │
│  │  • Plan, dry-run, approve, execute, verify, receipt              │    │
│  │  • Repair, cutover (promoted from experimental)                  │    │
│  │  • Durable state machine (33 states)                            │    │
│  │  • Fencing, leasing, checkpointing                              │    │
│  └────────┬───────────┬───────────┬───────────┬────────────────────┘    │
│           │           │           │           │                          │
│  ┌────────▼─────┐ ┌───▼────┐ ┌───▼────┐ ┌────▼─────┐ ┌──────────────┐ │
│  │Connector     │ │Source  │ │Target  │ │Worker    │ │Scheduler     │ │
│  │Registry      │ │Pool   │ │Pool    │ │Pool      │ │(cron/DAG)    │ │
│  │(pluggable)   │ │       │ │        │ │(distrib.)│ │              │ │
│  └──────────────┘ └───────┘ └────────┘ └──────────┘ └──────────────┘ │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │                    Observability                                  │    │
│  │  • Prometheus metrics (counters, histograms, gauges)             │    │
│  │  • Structured JSON audit log                                     │    │
│  │  • Health/readiness probes                                       │    │
│  │  • OpenTelemetry traces (future)                                 │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Level 3: Component Diagram — Command Service Internals

```
┌───────────────────────────────────────────────────────────────────┐
│                    SpoolCommandService                             │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Execution    │  │ Verification │  │ State Machine            │ │
│  │ Policy       │  │ Engine       │  │ (33 states, CAS          │ │
│  │ (production/ │  │ (row_acct,   │  │  transitions, recovery   │ │
│  │  quali mode) │  │  ledger,     │  │  decisions)              │ │
│  │              │  │  content,    │  │                          │ │
│  │  CHANGE:     │  │  merkle)     │  │                          │ │
│  │  raise 256M  │  │              │  │                          │ │
│  │  → 10G       │  │              │  │                          │ │
│  │  add PG/MY/  │  │              │  │                          │ │
│  │  MS targets  │  │              │  │                          │ │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘ │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Connector    │  │ Lease Store  │  │ Receipt Generator        │ │
│  │ Runtime      │  │ (SQLite for  │  │ (SHA-256 bound,          │ │
│  │ Registry     │  │  local; PG   │  │  canonical JSON,         │ │
│  │              │  │  for distrib)│  │  release-pinned)         │ │
│  │  + Snowflake │  │              │  │                          │ │
│  │  + BigQuery  │  │  CHANGE:     │  │                          │ │
│  │              │  │  add distrib │  │                          │ │
│  │              │  │  lease coord │  │                          │ │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘ │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Checkpoint   │  │ Approval     │  │ Credential Broker        │ │
│  │ Manager      │  │ System       │  │ (secret isolation,       │ │
│  │ (crash-safe, │  │ (HMAC-SHA256,│  │  leak detection,         │ │
│  │  commit-     │  │  time-bound, │  │  vault integration)      │ │
│  │  before-     │  │  single-use) │  │                          │ │
│  │  checkpoint) │  │              │  │  CHANGE: add HashiCorp   │ │
│  │              │  │              │  │  Vault, AWS Secrets Mgr  │ │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

### Level 4: Code — Key Module Changes

```
src/
├── platform/
│   ├── production-policy.js    ← MODIFY: raise ceiling, add PG/MY/MS targets
│   ├── execution-policy.js     ← NEW: extracted from production-policy
│   ├── rbac.js                 ← NEW: role-based access control
│   ├── api-keys.js             ← NEW: API key management
│   └── sso.js                  ← NEW: SAML 2.0 / OIDC federation
├── connectors/
│   ├── snowflake/              ← NEW: Snowflake connector (C4)
│   │   ├── connection.js
│   │   ├── source.js
│   │   ├── target.js
│   │   ├── preflight.js
│   │   └── runtime.js
│   ├── bigquery/               ← NEW: BigQuery connector (C4)
│   │   ├── connection.js
│   │   ├── target.js
│   │   ├── preflight.js
│   │   └── runtime.js
│   ├── postgres/               ← PROMOTE: experimental → production
│   ├── mysql/                  ← PROMOTE: add content verification + repair
│   └── mssql/                  ← PROMOTE: add content verification + repair
├── daemon/
│   ├── spoold.js               ← MODIFY: OpenAPI, auth middleware, metrics
│   ├── spoold-v2.js            ← NEW: REST API gateway
│   ├── metrics.js              ← NEW: Prometheus registry
│   ├── audit-log.js            ← NEW: immutable structured audit
│   └── scheduler.js            ← NEW: cron + DAG scheduling
├── observability/              ← NEW
│   ├── prometheus.js           ← Metrics registry + /metrics endpoint
│   ├── health.js               ← /healthz, /readyz probes
│   └── tracing.js              ← OpenTelemetry spans (future)
└── workers/                    ← NEW: horizontal scaling coordination
    ├── coordinator.js          ← Partition assignment, worker registration
    ├── worker-node.js          ← Individual worker lifecycle
    └── partition-strategy.js   ← Source partitioning (range/hash/round-robin)
```

---

## 4. Phase Roadmap

### Phase 1: Foundation (Months 1–3) — "Credible Migration Platform"

**Goal**: Cross the threshold from "demo" to "usable for real work"

| # | Deliverable | Effort | Dependencies |
|---|---|---|---|
| 1.1 | **Raise source ceiling to 10 GB** | 1 week | Update `PRODUCTION_POLICY`, streaming already bounded-memory |
| 1.2 | **PostgreSQL target → PRODUCTION** | 4 weeks | Independent 10M+ qualification, content verification proof, fault/recovery suite on separate host |
| 1.3 | **REST API v1 (OpenAPI)** | 3 weeks | Extend `spoold` with OpenAPI spec, proper HTTP methods, versioned routes |
| 1.4 | **API key authentication** | 2 weeks | Key generation/rotation/revocation, scoped permissions |
| 1.5 | **Prometheus metrics export** | 2 weeks | Counters, histograms, gauges for all operations |
| 1.6 | **Health/readiness probes** | 1 week | `/healthz`, `/readyz` for container orchestration |
| 1.7 | **Structured audit log** | 2 weeks | Immutable, queryable, retention-policy-bound |

**Exit criteria**: PG target production-qualified at 10M+ rows; API callable from
scripts; metrics scrapeable by Prometheus; audit trail queryable.

### Phase 2: Enterprise Connectors (Months 3–6) — "Real Database Coverage"

| # | Deliverable | Effort | Dependencies |
|---|---|---|---|
| 2.1 | **MySQL target → PRODUCTION** | 4 weeks | Add content verification, repair path, 10M+ qualification |
| 2.2 | **SQL Server target → PRODUCTION** | 4 weeks | Same as MySQL |
| 2.3 | **Snowflake connector** (target C4) | 6 weeks | Snowflake SDK, stage-based COPY, warehouse billing awareness |
| 2.4 | **BigQuery connector** (target C4) | 5 weeks | BigQuery Storage Write API, streaming buffer awareness |
| 2.5 | **PostgreSQL source → PRODUCTION** | 3 weeks | Independent reproduction of snapshot/keyset semantics |
| 2.6 | **MySQL/MSSQL source → PRODUCTION** | 3 weeks each | Same qualification pattern |

**Exit criteria**: 6 production-qualified targets; cloud warehouse coverage (Snowflake + BigQuery).

### Phase 3: Multi-User & Security (Months 5–8) — "Team-Ready"

| # | Deliverable | Effort | Dependencies |
|---|---|---|---|
| 3.1 | **RBAC system** (admin/operator/viewer/api-client) | 4 weeks | Phase 1.4 API keys |
| 3.2 | **SSO/SAML 2.0** (Okta, Azure AD, Google Workspace) | 4 weeks | RBAC foundation |
| 3.3 | **Per-workspace permissions** | 2 weeks | RBAC + workspace model |
| 3.4 | **Credential vault integration** (HashiCorp Vault, AWS Secrets Manager) | 3 weeks | Extends credential broker |
| 3.5 | **SOC 2 Type I readiness** | 6 weeks | Policies, controls, evidence collection framework |
| 3.6 | **Data classification & PII awareness** | 3 weeks | Column-level sensitivity tags, masking in logs |

**Exit criteria**: Multi-user teams can share workspaces with role-based access;
SSO login works with Okta/Azure AD; SOC 2 Type I policies documented and
controls implemented.

### Phase 4: Scale & Orchestration (Months 7–10) — "Enterprise Operational"

| # | Deliverable | Effort | Dependencies |
|---|---|---|---|
| 4.1 | **Horizontal scaling** (distributed fenced workers) | 6 weeks | Workers.js prototype exists; extend to multi-node coordination, partition assignment |
| 4.2 | **Scheduling engine** (cron + one-shot + DAG) | 4 weeks | Built-in scheduler |
| 4.3 | **Airflow operator** | 2 weeks | Phase 1.3 REST API |
| 4.4 | **Temporal activity** | 2 weeks | Phase 1.3 REST API |
| 4.5 | **Source ceiling → 100 GB** | 2 weeks | Streaming already bounded-memory; partitioned source reading |
| 4.6 | **Parallel source reading** (multi-worker source partitions) | 4 weeks | Phase 4.1 horizontal scaling |
| 4.7 | **Grafana dashboard templates** | 2 weeks | Phase 1.5 Prometheus metrics |

**Exit criteria**: 100 GB sources processed across multiple workers; migrations
schedulable from Airflow/Temporal; Grafana dashboards deployable.

### Phase 5: Managed Service & Compliance (Months 9–14) — "Cloud-Ready"

| # | Deliverable | Effort | Dependencies |
|---|---|---|---|
| 5.1 | **SPOOL Cloud** (multi-tenant managed service) | 10 weeks | All previous phases |
| 5.2 | **Tenant isolation** (separate state DBs, credential vaults) | 4 weeks | Phase 5.1 |
| 5.3 | **Usage metering & billing** | 4 weeks | Phase 5.1 |
| 5.4 | **SOC 2 Type II audit** | 12 weeks | 3-month observation period |
| 5.5 | **GDPR/CCPA data processing agreement** | 4 weeks | Legal review |
| 5.6 | **Auto-update channel** (signed releases) | 3 weeks | Code signing certificate |
| 5.7 | **SLA framework** (99.9% for managed, best-effort for self-hosted) | 2 weeks | Monitoring + on-call |

**Exit criteria**: Managed service running multi-tenant; SOC 2 Type II report
issued; contractual SLA available.

### Timeline Visualization

```
Month:  1    2    3    4    5    6    7    8    9   10   11   12   13   14
        ├────┼────┼────┼────┼────┼────┼────┼────┼────┼────┼────┼────┼────┤
Phase 1 ████████████████ Foundation
Phase 2              ████████████████████ Enterprise Connectors
Phase 3                       ████████████████████ Multi-User & Security
Phase 4                                ████████████████████ Scale & Orch.
Phase 5                                         ████████████████████████ Cloud
```

---

## 5. Architecture Decision Records (ADRs)

### ADR-001: Raise Source Ceiling via Policy Pin (Not Architecture Change)

**Status**: PROPOSED  
**Context**: The 256 MiB ceiling is a `PRODUCTION_POLICY` pin, not an
architectural limit. The CSV parser (`stream-csv.js`) already uses bounded-memory
streaming. The ceiling exists because qualification evidence was only produced
at 256 MiB.

**Decision**: Raise `maxSourceBytes` to `10 * 1024 * 1024 * 1024` (10 GB) in
`production-policy.js`. Produce qualification evidence at 1 GB and 10 GB tiers.
The architecture is unchanged — the streaming parser handles arbitrary sizes.

**Consequences**:
- Must produce sustained-load + crash-recovery evidence at 10 GB tier
- Must verify bounded memory (RSS stays flat as source grows)
- Must update `matrixSha256` pin (matrix.json changes)
- Future: 100 GB via partitioned source reading (Phase 4)

**Alternatives rejected**:
- Removing the ceiling entirely (lose fail-closed on accidentally huge files)
- Making it configurable per-operation (lose the policy-pin safety property)

---

### ADR-002: PostgreSQL Target Promotion — Independent Reproduction

**Status**: PROPOSED  
**Context**: PG target is EXPERIMENTAL with C4 assurance. The conformance suite
exists (`postgres-conformance.test.js`, 22 tests) and reference workloads run
against Docker PG 17.6. The gap is "independently reproduced" — tests only run
on the author's machine. Production qualification requires reproducible
evidence on a separate host.

**Decision**: 
1. Set up a qualification CI runner (GitHub Actions with `services: postgres:17`)
2. Run the full conformance suite + reference workloads at 100K/1M/10M tiers
3. Run fault injection (kill -9 during batch, network partition, OOM)
4. Run content verification + repair cycle at 1M tier
5. Record evidence with commit-bound hashes
6. Promote PG target in `PRODUCTION_POLICY` and capability matrix

**Consequences**:
- `PRODUCTION_POLICY.target` becomes `['sqlite', 'postgres']`
- `createExecutionPolicy.assert()` updated to accept `target === 'postgres'`
- New write strategies allowed: `insert`, `upsert` (PG only)
- Bulk COPY allowed for PG (already implemented, needs production evidence)

---

### ADR-003: REST API Design — Extend spoold, Don't Replace It

**Status**: PROPOSED  
**Context**: `spoold.js` serves `POST /v1/command` with a single endpoint and
bearer token auth. Enterprise users need: versioned REST routes, OpenAPI spec,
multiple auth methods, proper HTTP verbs, pagination.

**Decision**: Create `spoold-v2.js` alongside the existing daemon, sharing the
same `SpoolCommandService` kernel. The v2 API:

```
POST   /v2/migrations                    # create
GET    /v2/migrations                    # list (paginated)
GET    /v2/migrations/:id                # status
POST   /v2/migrations/:id/plan           # plan
POST   /v2/migrations/:id/dry-run        # dry-run
POST   /v2/migrations/:id/approve        # approve
POST   /v2/migrations/:id/execute        # execute
GET    /v2/migrations/:id/receipt         # receipt
GET    /v2/migrations/:id/verification    # verification
GET    /v2/migrations/:id/transitions     # state machine history
POST   /v2/migrations/:id/evidence/export # evidence bundle
GET    /v2/health                         # health probe
GET    /v2/ready                          # readiness probe
GET    /v2/metrics                        # Prometheus exposition
```

Authentication: `Authorization: Bearer <token>` (existing), `X-API-Key: <key>`
(new), `Authorization: Bearer <jwt>` (SSO, Phase 3).

**Consequences**:
- v1 endpoint preserved for backward compatibility
- OpenAPI 3.1 spec generated and version-controlled
- Rate limiting per API key
- Audit log records every API call with principal + timestamp + operation

---

### ADR-004: RBAC Model — Four Roles, Workspace-Scoped

**Status**: PROPOSED  
**Context**: Current system authenticates via a single bearer token with no
authorization differentiation. Enterprise teams need role separation.

**Decision**: Implement four roles:

| Role | Can do | Cannot do |
|---|---|---|
| `admin` | Everything + user management + settings + API key management | — |
| `operator` | Create/plan/dry-run/approve/execute/view migrations | User management, settings |
| `viewer` | View migrations, status, receipts, evidence | Any mutation |
| `api-client` | Programmatic access scoped by API key permissions | UI access, user management |

Permissions are **workspace-scoped**: an operator in workspace A cannot see
workspace B's migrations.

Storage: `spool_users` and `spool_permissions` tables in the metadata store.
For self-hosted: SQLite. For managed service: PostgreSQL.

**Consequences**:
- Every API call checks `rbac.authorize(principal, action, resource)`
- Audit log includes principal identity
- API keys are scoped to roles + workspaces
- Migration approvals are bound to the approving principal's identity

---

### ADR-005: SSO/SAML Integration — OIDC-First, SAML Bridge

**Status**: PROPOSED  
**Context**: Enterprise identity is Okta, Azure AD, or Google Workspace.
Supporting all three via native protocols is expensive. OIDC is the modern
standard; SAML is legacy but required.

**Decision**:
1. Primary: OpenID Connect (OIDC) — works natively with Okta, Azure AD, Google
2. Bridge: SAML 2.0 → OIDC via a lightweight assertion consumer
3. Library: `openid-client` (maintained, certified, no native dependencies)
4. Token exchange: IdP JWT → SPOOL session token (short-lived, refreshable)
5. Group mapping: IdP groups → SPOOL roles (configurable mapping table)

Self-hosted deployment provides the OIDC configuration; managed service handles
it automatically.

**Consequences**:
- Approval signing key REMAINS machine-local (DPAPI/keychain) — SSO authenticates
  the human, the machine key signs the approval
- Multi-factor authentication is enforced by the IdP, not by SPOOL
- Session tokens have configurable TTL (default 8 hours)

---

### ADR-006: Snowflake Connector — Stage-Based COPY with Ledger

**Status**: PROPOSED  
**Context**: Snowflake is the dominant cloud data warehouse. Write path:
PUT to stage → COPY INTO. No traditional transactions — uses Snowflake's
micro-partitioning and result scanning.

**Decision**:
1. **Write strategy**: PUT CSV/Parquet chunks to internal stage → `COPY INTO`
2. **Fencing**: Advisory lock table in Snowflake (`SPOOL_EXECUTION_LEASES`)
   using `CREATE OR REPLACE` + `MERGE` for CAS semantics
3. **Batch ledger**: `SPOOL_BATCH_LEDGER` table with identical schema to
   PostgreSQL ledger
4. **Content verification**: `SELECT COUNT(*)` + checksum queries after load
5. **Assurance level**: C4 (transaction-bound commit evidence + fencing)
6. **Credentials**: Snowflake key-pair auth (no password); integrate with
   credential broker
7. **Warehouse awareness**: auto-suspend/resume, configurable warehouse size
   for cost control

**Consequences**:
- Snowflake SDK (`snowflake-sdk`) added as optional peer dependency
- Stage cleanup after successful migration (configurable retention)
- Billing awareness: document warehouse credit consumption in receipts
- No `BEGIN/COMMIT` — Snowflake auto-commits; ledger provides the consistency
  layer

---

### ADR-007: BigQuery Connector — Storage Write API

**Status**: PROPOSED  
**Context**: BigQuery dominates in GCP. The Storage Write API provides
exactly-once semantics via stream-based writes with offset tracking.

**Decision**:
1. **Write strategy**: BigQuery Storage Write API with committed mode
2. **Fencing**: Application-level via `_spool_execution_leases` table
3. **Batch ledger**: `_spool_batch_ledger` table
4. **Content verification**: `SELECT COUNT(DISTINCT *)` + hash aggregation
5. **Credentials**: Google Cloud service account key or workload identity
6. **Cost awareness**: Streaming insert pricing vs. load job pricing documented

**Consequences**:
- `@google-cloud/bigquery-storage` added as optional peer dependency
- Dataset-scoped permissions required (not project-wide)
- Partition-aware loading supported (date/integer partitioning)

---

### ADR-008: Horizontal Scaling — Coordinator + Worker Pool

**Status**: PROPOSED  
**Context**: `src/connectors/postgres/workers.js` implements single-database
distributed fenced workers (138 lines). The pattern needs generalization to
multi-node coordination for any connector.

**Decision**:
1. **Coordinator**: A new process that partitions sources and assigns ranges
   to worker nodes via the PostgreSQL lease table
2. **Workers**: Stateless processes that claim partitions, execute batches,
   checkpoint, and heartbeat
3. **Partition strategies**:
   - Range partition (by PK range for database sources)
   - Hash partition (by row hash for CSV sources)
   - Round-robin (for balanced distribution)
4. **Communication**: PostgreSQL-backed coordination (no Kafka/Redis/RabbitMQ
   dependency) — the lease table IS the coordination mechanism
5. **Failure handling**: Worker crash → lease expires → partition reassigned →
   checkpoint-based resume

**Consequences**:
- Horizontal scaling works only with PostgreSQL as the coordination store
  (acceptable: it's the most common production target)
- Single-node mode unchanged — workers.js is opt-in
- Coordinator is a separate process (`spool-coordinator`) deployable as a
  sidecar or standalone
- Worker count is operator-configured (no auto-scaling in v1)

---

### ADR-009: Prometheus Metrics — Pull Model with /metrics Endpoint

**Status**: PROPOSED  
**Context**: Enterprise ops teams require Prometheus-compatible metrics for
dashboards, alerting, and capacity planning.

**Decision**: Add a `prom-client`-based metrics registry exposed at
`GET /v2/metrics` in Prometheus exposition format.

**Metrics catalogue**:

| Metric | Type | Labels | Description |
|---|---|---|---|
| `spool_migrations_total` | Counter | `status`, `target` | Total migrations by outcome |
| `spool_migrations_active` | Gauge | `target` | Currently executing migrations |
| `spool_rows_processed_total` | Counter | `migration_id`, `target` | Rows processed |
| `spool_rows_written_total` | Counter | `migration_id`, `target` | Rows written |
| `spool_rows_rejected_total` | Counter | `migration_id`, `target` | Rows rejected |
| `spool_batch_duration_seconds` | Histogram | `target` | Per-batch execution time |
| `spool_source_bytes_total` | Counter | `source_type` | Source bytes read |
| `spool_verification_duration_seconds` | Histogram | `target` | Verification time |
| `spool_lease_acquisitions_total` | Counter | `outcome` | Lease acquire attempts |
| `spool_api_requests_total` | Counter | `method`, `route`, `status` | API requests |
| `spool_api_latency_seconds` | Histogram | `method`, `route` | API latency |
| `spool_approval_expirations_total` | Counter | — | Expired approvals |
| `spool_checkpoint_writes_total` | Counter | `migration_id` | Checkpoint writes |
| `spool_worker_heartbeats_total` | Counter | `worker_id` | Worker heartbeats |

**Consequences**:
- `prom-client` added as dependency (mature, standard)
- Metrics are opt-in: disabled by default, enabled via config flag
- No PII in metrics labels (migration_id is a UUID, not content)
- Grafana dashboard JSON committed as `dashboards/spool.json`

---

### ADR-010: SOC 2 Type I → Type II Path

**Status**: PROPOSED  
**Context**: Regulated industries require compliance evidence. SOC 2 is the
de facto standard for SaaS/infrastructure services.

**Decision**: Two-stage approach:

**Type I (point-in-time, Phase 3)**:
1. Write 5 Trust Service Criteria policies: Security, Availability, Processing
   Integrity, Confidentiality, Privacy
2. Implement controls: access control (RBAC), change management (signed
   releases), incident response (runbook), monitoring (Prometheus alerts),
   data retention (audit log)
3. Engage auditor for point-in-time assessment

**Type II (period-of-time, Phase 5)**:
1. 3-month observation period with evidence collection
2. Continuous control monitoring (automated evidence from audit log + metrics)
3. Annual renewal

**Consequences**:
- Policies versioned in `docs/compliance/soc2/`
- Control evidence generated automatically from audit log + metrics
- Audit log retention: 1 year minimum (configurable)
- Incident response runbook at `docs/operations/incident-response.md`

---

### ADR-011: Scheduling — Built-in Cron + External Integration

**Status**: PROPOSED  
**Context**: Enterprises need recurring migrations (nightly imports, hourly CDC
syncs). Supporting both built-in scheduling and external orchestration avoids
lock-in.

**Decision**:
1. **Built-in**: Simple cron-expression scheduler (`node-cron` or equivalent)
   for basic scheduling inside `spoold-v2`
2. **Airflow operator**: `spool-airflow-operator` Python package wrapping the
   REST API — `SpoolPlanOperator`, `SpoolDryRunOperator`,
   `SpoolApproveAndExecuteOperator`, `SpoolVerifyOperator`
3. **Temporal activity**: `spool-temporal` Node package wrapping the REST API
4. **Webhook notifications**: POST to configurable URL on migration
   complete/fail (for custom orchestration)

**Consequences**:
- Built-in scheduler stores schedules in metadata DB
- External orchestrators use the REST API (no special integration)
- Approval still requires human interaction (cannot be auto-approved by cron)
  unless explicitly configured with a service account + pre-authorized plan

---

### ADR-012: Cloud-Hosted Managed Service Architecture

**Status**: PROPOSED  
**Context**: Enterprises want "just use it" without infrastructure management.

**Decision**:
1. **Deployment**: Kubernetes on AWS EKS / GCP GKE
2. **Tenant isolation**: Separate schema per tenant in shared PostgreSQL
   (metadata); separate state DBs per migration (existing pattern)
3. **Data plane isolation**: Customer data never persists in SPOOL infrastructure
   — it streams through workers and writes directly to customer targets
4. **Control plane**: SPOOL manages scheduling, monitoring, RBAC, audit
5. **Networking**: VPC peering / PrivateLink for customer database access
6. **Billing**: Per-row metered pricing + base platform fee

**Consequences**:
- Self-hosted and managed service share the same codebase
- Managed service adds: tenant router, billing metering, VPC networking
- Data sovereignty claims must be scoped: "data transits SPOOL workers in
  memory during migration" (documented precisely in DPA)

---

## 6. Detailed Requirements by Phase

### Phase 1 Requirements

#### REQ-1.1: Raise Source Ceiling to 10 GB

**Priority**: P0  
**Acceptance criteria**:
1. `PRODUCTION_POLICY.maxSourceBytes` = `10 * 1024 * 1024 * 1024`
2. Qualification evidence at 1 GB tier: sustained-load, bounded-memory (RSS < 200 MB)
3. Qualification evidence at 10 GB tier: sustained-load, bounded-memory (RSS < 250 MB)
4. Crash recovery at 5 GB tier: kill -9 mid-batch → resume → complete → receipt VERIFIED
5. `matrixSha256` updated and verified
6. `PRODUCTION_POLICY.source` remains `filesystem` (CSV); PG sources Phase 2
7. Backward compatible: existing 256 MiB migrations unaffected

**Implementation notes**:
- `stream-csv.js` already uses `createReadStream` with bounded buffers — no parser change
- `checkpoint.js` already handles arbitrary file sizes — no checkpoint change  
- The ONLY change is the policy pin value + new qualification evidence

#### REQ-1.2: PostgreSQL Target → PRODUCTION

**Priority**: P0  
**Acceptance criteria**:
1. Conformance suite passes on GitHub Actions CI with `services: postgres:17`
2. 10M row tier qualification: sustained throughput ≥ 100K rows/sec
3. 50M row tier qualification: completes without OOM or disk panic
4. Fault injection suite: kill -9 during batch 50 of 100 → resume → verify
5. Content verification at 10M rows: detect 1 tampered row among 10M
6. Repair cycle: tamper → verify_fail → repair_approve → repair_run → re-verify → receipt
7. Bulk COPY path qualified with same evidence
8. Evidence committed with commit-bound hashes
9. `PRODUCTION_POLICY.target` includes `'postgres'`
10. Write strategies `insert` and `upsert` allowed in production mode
11. Bulk writes allowed for PG in production mode

**Implementation notes**:
- PostgreSQL source/target/runtime code already exists (941 lines in target.js)
- Content verification exists (128 lines in content-verification.js)
- The work is QUALIFICATION (evidence production), not implementation
- Need a CI host with enough disk for 50M rows (~5 GB data)

#### REQ-1.3: REST API v1

**Priority**: P0  
**Acceptance criteria**:
1. OpenAPI 3.1 spec at `docs/api/openapi.yaml`, version-controlled
2. Routes per ADR-003
3. Pagination on list endpoints (cursor-based, default page size 50)
4. Request validation via schema (reuse zod from contracts.js)
5. Error envelopes match existing `toErrorEnvelope` structure
6. API versioning via URL path (`/v2/...`)
7. CORS headers configurable
8. Backward compatible: `/v1/command` still works

#### REQ-1.4: API Key Authentication

**Priority**: P0  
**Acceptance criteria**:
1. `POST /v2/api-keys` → creates key (returns key once, hashed for storage)
2. `DELETE /v2/api-keys/:id` → revokes key (immediate)
3. `GET /v2/api-keys` → lists keys (metadata only, never the secret)
4. Keys scoped to permissions (read-only, operator, admin)
5. Key rotation: create new → migrate → revoke old
6. Rate limiting per key (configurable, default 100 req/min)
7. Key never logged or included in error messages

#### REQ-1.5: Prometheus Metrics

**Priority**: P1  
**Acceptance criteria**:
1. Metrics catalogue per ADR-009
2. `GET /v2/metrics` returns Prometheus exposition format
3. Metrics opt-in via config (disabled by default)
4. No PII in label values
5. Histogram buckets: `[0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 120, 300]`
6. Counter reset on process restart (standard Prometheus behavior)
7. Grafana dashboard JSON at `dashboards/spool.json`

#### REQ-1.6: Health & Readiness Probes

**Priority**: P1  
**Acceptance criteria**:
1. `GET /v2/health` → `{ status: "ok" }` if process is alive
2. `GET /v2/ready` → `{ status: "ready" }` if metadata DB is accessible + engine loaded
3. Both return 200 on success, 503 on failure
4. Compatible with Kubernetes liveness/readiness probes

#### REQ-1.7: Structured Audit Log

**Priority**: P1  
**Acceptance criteria**:
1. Every API call logged: `{ timestamp, principal, action, resource, outcome, ip }`
2. Every migration state transition logged: `{ timestamp, migrationId, from, to, principal }`
3. Immutable (append-only table, no UPDATE/DELETE)
4. Queryable by time range, principal, action, resource
5. Configurable retention (default 365 days, min 90 days)
6. Exportable as JSON-lines for external SIEM integration

### Phase 2 Requirements (Enterprise Connectors)

#### REQ-2.1: MySQL Target → PRODUCTION

**Priority**: P0  
**Acceptance criteria**:
1. Content verification implemented (currently missing from MySQL connector)
   - Read-after-write SELECT with checksum aggregation
   - Tamper detection at 1M rows: detect 1 changed row
2. Repair path implemented (currently missing)
   - Repair approval (separate from migration approval)
   - Fenced repair execution with preconditions
   - Re-verification after repair
3. 10M row qualification on CI with `services: mysql:8`
4. Fault injection: crash mid-batch → resume → complete
5. `PRODUCTION_POLICY.target` includes `'mysql'`

#### REQ-2.2: SQL Server Target → PRODUCTION

Same pattern as REQ-2.1 but for `mssql`. Target CI: `services: mcr.microsoft.com/mssql/server:2022-latest`.

#### REQ-2.3: Snowflake Connector

**Priority**: P1  
**Acceptance criteria** (per ADR-006):
1. Stage-based COPY INTO with batch ledger
2. C4 assurance (fencing + commit evidence)
3. Content verification via SQL aggregation
4. 1M row qualification
5. Credential broker integration (key-pair auth)
6. Warehouse cost documented in receipt
7. Conformance suite passing
8. Cleanup: stage files removed after success

#### REQ-2.4: BigQuery Connector

**Priority**: P1  
**Acceptance criteria** (per ADR-007):
1. Storage Write API with committed mode
2. C4 assurance
3. Content verification via SQL aggregation
4. 1M row qualification
5. Service account authentication
6. Cost awareness documented

### Phase 3 Requirements (Multi-User & Security)

#### REQ-3.1: RBAC

Per ADR-004. Four roles, workspace-scoped. Test coverage: role A cannot access
workspace B; viewer cannot approve; operator cannot manage users.

#### REQ-3.2: SSO/SAML

Per ADR-005. OIDC primary, SAML bridge. Test: Okta login → SPOOL session →
API call succeeds with SSO JWT. Test: expired session → re-auth required.

#### REQ-3.5: SOC 2 Type I

**Priority**: P1  
**Acceptance criteria**:
1. Security policy document at `docs/compliance/soc2/security-policy.md`
2. Availability/support commitments at `docs/compliance/soc2/SLA_AND_SUPPORT_POLICY.md`
3. Processing integrity policy (strongest: receipts = proof of integrity)
4. Confidentiality policy (credential isolation, no data telemetry)
5. Privacy/data-classification handling at `docs/compliance/soc2/03-data-classification-handling-policy.md`
6. Controls matrix mapping policies → implementation evidence
7. Access review process documented
8. Incident response runbook at `docs/operations/incident-response.md`
9. Change management process documented (signed releases, PR reviews)

These documents are internal drafts written against the SOC 2 Trust Services Criteria.
They are not an audit and no auditor has issued a report; see
`docs/compliance/soc2/README.md` and `engineering/completion/BLOCKERS.json` B004.

### Phase 4 Requirements (Scale & Orchestration)

#### REQ-4.1: Horizontal Scaling

Per ADR-008. Test: 3 workers processing 100M rows with 50/25/25 partition
split → all batches committed with distinct fencing tokens → single receipt
covering all workers' contributions.

#### REQ-4.2-4.4: Scheduling & Integration

Per ADR-011. Test: cron schedule fires at configured time → migration executes →
receipt generated → webhook fires.

Airflow test: DAG with SpoolPlanOperator → SpoolDryRunOperator →
SpoolApproveAndExecuteOperator → SpoolVerifyOperator → all succeed.

### Phase 5 Requirements (Cloud & Compliance)

#### REQ-5.1: Managed Service

Per ADR-012. Test: tenant A and tenant B share infrastructure; A's migrations
are invisible to B; billing reflects A's usage only.

#### REQ-5.4: SOC 2 Type II

3-month observation window. Auditor engagement. Annual renewal.

---

## 7. Non-Functional Requirements

### Performance

| Dimension | Requirement | Rationale |
|---|---|---|
| Source throughput (CSV → SQLite) | ≥ 40K rows/sec | Current benchmark baseline |
| Source throughput (CSV → PG) | ≥ 100K rows/sec | Current PG benchmark |
| Source throughput (PG → PG) | ≥ 80K rows/sec | Database-to-database |
| Snowflake load throughput | ≥ 50K rows/sec | Stage-based COPY bottleneck |
| API latency (p99) | < 500ms for status/list | Standard SaaS expectation |
| Worker heartbeat interval | ≤ 30 seconds | Lease TTL = 5 min → 10× safety |
| Checkpoint interval | ≤ 60 seconds | Max replayable window on crash |

### Reliability

| Dimension | Requirement |
|---|---|
| Crash recovery | Resume from checkpoint within 60s of restart |
| Data correctness | Zero silent data loss (existing guarantee, preserved) |
| Lease fencing | Monotonic tokens prevent ABA in all connectors |
| Receipt binding | Every COMPLETE migration has a verifiable receipt |

### Security

| Dimension | Requirement |
|---|---|
| Secrets | Never logged, never in error messages, never returned via API |
| Transport | TLS 1.2+ for all network connections |
| Auth | API key or SSO JWT; no anonymous access |
| Audit | Every mutation logged with principal + timestamp |
| Data | Customer data never persists in SPOOL infrastructure (managed service) |

### Scalability

| Dimension | Phase 1 | Phase 4 | Phase 5 |
|---|---|---|---|
| Source size | 10 GB | 100 GB | 1 TB |
| Concurrent migrations | 10 | 100 | 1,000 |
| Workers per migration | 1 | 8 | 32 |
| API requests/sec | 100 | 1,000 | 10,000 |

---

## 8. Risk Register

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Snowflake SDK instability / breaking changes | Medium | High | Pin SDK version, integration tests in CI, abstraction layer |
| R2 | SOC 2 audit cost ($30K–$50K) | High | Medium | Budget early; Type I first to defer Type II cost |
| R3 | Horizontal scaling introduces consistency bugs | Medium | Critical | Fencing token is the invariant — property-based testing |
| R4 | SSO integration complexity across IdPs | Medium | Medium | OIDC-first (standard), SAML bridge only for legacy |
| R5 | Production PG qualification at 50M rows needs CI disk | Low | Medium | Use cloud CI with ephemeral 100 GB volumes |
| R6 | Cloud managed service multi-tenant security | Medium | Critical | Separate state DBs per tenant, VPC isolation, pen testing |
| R7 | Single-developer bus factor | High | Critical | Document everything, hire early, open-source community |
| R8 | Enterprise customers need contractual SLA before buying | High | High | Phase 5 managed service required for SLA; self-hosted = best-effort |

---

## 9. Success Metrics

### Phase 1 Exit (Month 3)

| Metric | Target |
|---|---|
| PG target 10M qualification | PASS with ≥ 100K rows/sec |
| API endpoint coverage | 100% of command surface |
| Prometheus scrape works | Grafana dashboard renders |
| Audit log query latency | < 100ms for 90-day range |

### Phase 2 Exit (Month 6)

| Metric | Target |
|---|---|
| Production-qualified targets | ≥ 6 (SQLite, PG, MySQL, MSSQL, Snowflake, BigQuery) |
| Connector conformance test coverage | ≥ 95% per connector |
| Largest qualified migration | 50M rows (PG) |

### Phase 3 Exit (Month 8)

| Metric | Target |
|---|---|
| SSO login works with Okta | E2E test PASS |
| RBAC authorization coverage | 100% of API endpoints |
| SOC 2 Type I report | Issued by auditor |

### Phase 4 Exit (Month 10)

| Metric | Target |
|---|---|
| Horizontal 100M row migration | PASS with 3+ workers |
| Airflow operator e2e | DAG completes successfully |
| Source ceiling | 100 GB qualified |

### Phase 5 Exit (Month 14)

| Metric | Target |
|---|---|
| Managed service uptime | ≥ 99.9% over 30 days |
| Multi-tenant isolation | Pen test PASS |
| SOC 2 Type II report | Issued by auditor |
| Paying customers | ≥ 1 (validation of product-market fit) |

---

## 10. Appendices

### Appendix A: Capability Matrix Target State (v3.0)

| Capability | v1.1.2 Status | v3.0 Target |
|---|---|---|
| filesystem.source | PRODUCTION | PRODUCTION (10 GB) |
| sqlite.target | PRODUCTION | PRODUCTION |
| postgres.target | EXPERIMENTAL | **PRODUCTION** |
| postgres.source | EXPERIMENTAL | **PRODUCTION** |
| postgres.content-exact | EXPERIMENTAL | **PRODUCTION** |
| postgres.repair | EXPERIMENTAL | **PRODUCTION** |
| postgres.bulk | EXPERIMENTAL | **PRODUCTION** |
| postgres.cdc | EXPERIMENTAL | EXPERIMENTAL (promoted in v3.1) |
| postgres.workers | EXPERIMENTAL | **PRODUCTION** |
| mysql.target | EXPERIMENTAL | **PRODUCTION** |
| mysql.source | EXPERIMENTAL | **PRODUCTION** |
| mssql.target | EXPERIMENTAL | **PRODUCTION** |
| mssql.source | EXPERIMENTAL | **PRODUCTION** |
| snowflake.target | PLANNED | **PRODUCTION** |
| bigquery.target | PLANNED | **PRODUCTION** |
| rbac | — | **PRODUCTION** |
| sso | — | **PRODUCTION** |
| metrics | — | **PRODUCTION** |
| scheduling | — | **PRODUCTION** |
| horizontal-scaling | — | **PRODUCTION** |
| managed-service | — | **PRODUCTION** |
| soc2-type2 | — | Auditor-issued report (not started; no engagement) |

### Appendix B: Organizational Requirements

| Requirement | Current | Target | Timeline |
|---|---|---|---|
| Legal entity | None (sole proprietorship) | Incorporated company (India Pvt. Ltd or US LLC) | Month 1 |
| Team size | 1 | 3–5 (eng lead + 2 engineers + 1 DevOps + 1 security) | Months 1–3 |
| Revenue | $0 | $10K MRR (managed service) | Month 12 |
| Code signing | None | EV certificate ($500/yr) | Month 2 |
| Support | None | 8×5 (self-hosted), 24×7 (managed P1) | Month 8 |
| Insurance | None | E&O + cyber liability | Month 1 |
| Bank account | Personal | Business account | Month 1 |

### Appendix C: Technology Stack Additions

| Component | Library/Service | Rationale |
|---|---|---|
| API framework | `fastify` or extend `http.createServer` | Performance, schema validation |
| Metrics | `prom-client` | Standard Prometheus client |
| OIDC | `openid-client` | Certified OIDC RP library |
| Snowflake | `snowflake-sdk` | Official Snowflake driver |
| BigQuery | `@google-cloud/bigquery-storage` | Official BigQuery client |
| Scheduler | `node-cron` or custom | Minimal dependency |
| Kubernetes | Helm chart | Standard deployment |
| CI/CD | GitHub Actions | Already partially set up |

### Appendix D: File Structure After All Phases

```
spool/
├── src/
│   ├── connectors/
│   │   ├── sqlite/           (PRODUCTION — existing)
│   │   ├── postgres/         (PRODUCTION — promoted)
│   │   ├── mysql/            (PRODUCTION — promoted)
│   │   ├── mssql/            (PRODUCTION — promoted)
│   │   ├── snowflake/        (PRODUCTION — new)
│   │   ├── bigquery/         (PRODUCTION — new)
│   │   └── filesystem/       (PRODUCTION — existing)
│   ├── daemon/
│   │   ├── command-service.js (unchanged kernel)
│   │   ├── spoold.js          (v1 preserved)
│   │   ├── spoold-v2.js       (REST API gateway)
│   │   ├── credential-broker.js (+ vault integration)
│   │   ├── audit-log.js       (new)
│   │   ├── scheduler.js       (new)
│   │   └── metrics.js         (new)
│   ├── platform/
│   │   ├── production-policy.js (raised ceiling, multi-target)
│   │   ├── rbac.js              (new)
│   │   ├── api-keys.js          (new)
│   │   └── sso.js               (new)
│   ├── workers/                 (new — horizontal scaling)
│   └── observability/           (new — Prometheus, health)
├── apps/
│   ├── console/              (Electron desktop — existing)
│   └── cloud/                (managed service — new)
├── integrations/
│   ├── airflow/              (Airflow operator — new)
│   └── temporal/             (Temporal activity — new)
├── dashboards/
│   └── spool.json            (Grafana dashboard — new)
├── helm/
│   └── spool/                (Kubernetes Helm chart — new)
├── docs/
│   ├── api/
│   │   └── openapi.yaml      (OpenAPI spec — new)
│   ├── compliance/
│   │   └── soc2/             (SOC 2 policies — new)
│   ├── operations/
│   │   └── incident-response.md (runbook — new)
│   └── console/              (existing 21 docs)
└── qualification/            (CI-reproducible evidence — new)
    ├── postgres-10m/
    ├── postgres-50m/
    ├── mysql-10m/
    ├── mssql-10m/
    ├── snowflake-1m/
    └── bigquery-1m/
```

---

**Document end. This PRD is the planning contract. Implementation begins with
Phase 1.1 (raise the ceiling) — the smallest change with the largest impact on
credibility.**
