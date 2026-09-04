# SPOOL Hybrid Local-First Developer Platform Design

Date: 2026-09-05
Status: design approved in chat; written-spec review pending

## 1. Problem

SPOOL currently has a real deterministic migration engine, browser Worker execution, IndexedDB persistence, revision/checkpoint safety, validation, Autopilot planning, and browser WebMCP integration. Its product boundary is still narrow: the only production source path is a browser-loaded CSV, output is browser-local CSV/JSON, and agent access exists only through the active page's WebMCP tools.

The next product must turn SPOOL into a developer-grade migration and data-operation substrate without turning it into a hosted credential/data proxy by default.

## 2. Product decision

SPOOL uses a hybrid architecture with local-first as the default.

- Local mode: `spoold` runs on the developer machine. Credentials and raw dataset rows remain on that machine.
- Self-hosted mode: the same daemon/server runs in CI, a VM, Docker, Kubernetes, or an internal network.
- Hosted SPOOL control-plane features may exist later, but remote data-plane execution is opt-in and is not required for the core product.
- The browser website remains a safe product/documentation surface and can pair with a local bridge. It does not become an implicit database proxy.

Security invariant: credentials and raw dataset rows MUST NOT leave the local/self-hosted SPOOL process unless the user explicitly configures a remote connector or remote execution mode whose network boundary is visible in the plan.

## 3. Goals

1. Execute migrations against real systems, not only generated/demo data.
2. Preserve one deterministic command/mutation model across UI, CLI, API, MCP, WebMCP, and agents.
3. Provide real source and target adapters with schema discovery, streaming reads/writes, checkpoints, verification, and receipts.
4. Work as a local developer tool with minimal setup.
5. Work headlessly in CI/CD and self-hosted environments.
6. Allow agent clients to use SPOOL without clicking the website.
7. Keep destructive or ambiguous operations fail-closed.
8. Make every completed job auditable through source identity, plan revision, destination identity, verification evidence, and a receipt.
9. Keep the existing browser CSV flow working during the transition.

## 4. Non-goals for the first platform release

- A mandatory SPOOL cloud data plane.
- Arbitrary model-generated JavaScript/SQL execution.
- Supporting every database/vendor in the first release.
- General-purpose workflow automation unrelated to data movement/transformation.
- Pretending that CDC, distributed transactions, or zero-downtime cutovers exist before they are implemented and tested.

## 5. Decomposition

This architecture is intentionally split into independent subprojects. Each receives its own implementation spec/plan before code changes.

### P1 — Bridge foundation

`spoold`, shared execution contracts, connector interface, credential boundary, local API, standard MCP transports, job/receipt model, and a real SQLite/filesystem reference connector.

### P2 — Production connectors

PostgreSQL, MySQL, REST/OpenAPI, GraphQL, S3-compatible object storage, JSON/JSONL, and stronger bulk/streaming primitives.

### P3 — Studio pairing and WebMCP bridge

Pair the existing website with local `spoold` without weakening the current browser-only mode. Expose bridge state and jobs to WebMCP while preserving permission boundaries.

### P4 — Self-hosted runtime and CI

Container image, headless CLI, service mode, GitHub Actions/CI usage, policy files, non-interactive secrets, resumable jobs, and deployment documentation.

### P5 — Advanced migration capabilities

Parquet, MongoDB, Supabase/Postgres conveniences, warehouse connectors, schema-diff/DDL execution policy, incremental sync/CDC where technically sound, and richer verification strategies.

P1 is the first implementation target.

## 6. Architecture

```text
                         SPOOL website
                product / docs / local Studio
                          |       |
                  browser-only    | localhost pairing
                    mode          v
                           +---------------+
                           |    spoold     |
                           | local/server  |
                           +-------+-------+
                                   |
               +-------------------+-------------------+
               |                   |                   |
               v                   v                   v
           SPOOL Core       Connector Registry    Agent Gateway
      deterministic plan    source/target I/O     MCP / API / CLI
      transform + verify    secret handles        WebMCP bridge
               |                   |                   |
               +-------------------+-------------------+
                                   |
                            Job + Receipt Store
                                   |
         +-------------+-----------+-----------+-------------+
         v             v                       v             v
      files/CSV     PostgreSQL               REST/API      S3/R2
      JSON/JSONL    MySQL/SQLite             GraphQL       later...
```

### 6.1 Shared core

The existing deterministic migration logic remains the semantic center. Browser-specific concerns are separated from execution contracts so Node/server runtimes can invoke the same planning, transform, validation, and phase logic.

The core owns:

- target contracts;
- deterministic transformation IR;
- phase/state-machine semantics;
- plan revisions;
- validation;
- ambiguity classification;
- verification policy;
- typed command envelopes.

The core does not own credentials or vendor-specific network I/O.

### 6.2 `spoold`

`spoold` is a Node 22+ daemon that can run interactively or headlessly.

Default local bind:

- loopback only (`127.0.0.1` / `::1`);
- random or explicitly configured port;
- short-lived pairing token for browser access;
- strict Origin validation for browser requests;
- no LAN/public listening without explicit configuration;
- secrets never returned by inspect/list endpoints.

Self-hosted mode uses the same server with explicit listen address, authentication, policy, storage, and TLS/reverse-proxy configuration.

### 6.3 Connector contract

Every connector implements a capability-declared interface instead of SPOOL special-casing vendors.

Conceptual interface:

```ts
interface SpoolConnector {
  manifest(): ConnectorManifest;
  validateConfig(input): Promise<ValidatedConnection>;
  testConnection(ctx): Promise<ConnectionHealth>;
  discover(ctx, request): Promise<DiscoveryResult>;
  read(ctx, request): AsyncIterable<RowBatch>;
  planWrite(ctx, request): Promise<WritePlan>;
  write(ctx, request, batches): Promise<WriteResult>;
  verify(ctx, request): Promise<VerificationResult>;
  rollback?(ctx, receipt): Promise<RollbackResult>;
  close(): Promise<void>;
}
```

Connector manifests declare capabilities such as:

- source / target;
- schema discovery;
- streaming;
- transactions;
- bulk copy;
- upsert;
- DDL;
- rollback;
- checksum verification;
- pagination;
- rate-limit awareness.

The planner may only choose strategies that the connector explicitly advertises.

## 7. Real execution model

The source-to-target path must be real:

```text
CONNECT
  -> DISCOVER
  -> PROFILE
  -> PLAN
  -> DRY RUN
  -> ASSESS
  -> EXECUTE
  -> VERIFY
  -> RECEIPT
```

### Source

A source connector returns bounded row batches/records and metadata. Large datasets are not required to materialize completely in memory.

### Plan

SPOOL produces a serializable plan containing source identity, destination identity, mapping revision, write strategy, transaction/checkpoint policy, expected destructive effects, verification rules, and required approvals.

### Dry run

Dry run uses real connector metadata and real transformation/validation logic. For targets, it must avoid persistent mutation unless the target provides an isolated transaction/sandbox mechanism that is explicitly rolled back.

### Execute

Execution consumes batches, transforms them deterministically, validates them, writes through the selected connector strategy, and advances durable checkpoints only after the corresponding write is acknowledged.

### Verify

Verification is connector-aware and may include:

- processed/source row count;
- target row count;
- accepted/rejected counts;
- deterministic sample/hash comparison;
- primary-key coverage;
- null/type constraint checks;
- revision identity;
- connector-native transaction/commit identity where available.

A job cannot become `COMPLETE` merely because the write loop ended. It must satisfy its configured verification policy.

## 8. Job, plan, checkpoint, and receipt identities

The browser's current single-workspace state evolves into durable job records.

Minimum identities:

- `jobId` — one execution attempt lineage;
- `planId` and `planRevision` — immutable plan revision identity;
- `sourceRef` — redacted connector/resource identity plus fingerprint/snapshot evidence;
- `targetRef` — redacted destination identity;
- `checkpoint` — source cursor + committed target boundary;
- `receiptId` — immutable completion/failure evidence document.

A receipt records:

- tool/version/runtime;
- connector names and versions;
- redacted endpoint/resource identities;
- source fingerprint/snapshot evidence;
- plan hash/revision;
- processed/accepted/rejected counts;
- verification checks and outcomes;
- timing;
- commit/checkpoint identity;
- policy/approval events;
- terminal status.

No secret value is written into a receipt.

## 9. Credentials and secret handling

Local mode supports secret references rather than copying credentials into plans.

Preferred sources:

1. process environment references;
2. OS credential/keychain integration when available;
3. local encrypted secret store;
4. explicit ephemeral stdin/prompt entry.

Configuration stores a `secretRef`, never the resolved secret.

CLI/API/MCP inspection endpoints return redacted connection descriptors only.

Self-hosted mode additionally supports mounted files and orchestrator/container secret injection.

## 10. Agent and developer interfaces

All interfaces invoke the same command service. There is no separate agent business-logic implementation.

### 10.1 CLI

Initial command surface:

```text
spool init
spool connectors list
spool connect add
spool connect test
spool discover
spool plan
spool run
spool status
spool pause
spool resume
spool verify
spool receipt
spool mcp
spool serve
```

Machine-readable JSON output is available for automation.

### 10.2 Local/self-hosted API

Versioned API under `/v1` with typed JSON envelopes and explicit job handles. The API exposes metadata and bounded previews by default; returning raw rows requires an explicit endpoint/capability.

The API is not an unrestricted SQL proxy.

### 10.3 MCP

Provide standard MCP server operation over:

- stdio for local agent clients;
- Streamable HTTP for self-hosted/remote clients.

The implementation should follow the current protocol direction and avoid depending on hidden transport session state for SPOOL job state. Job/plan handles are explicit arguments/results so clients can reason about state.

Initial MCP tools should be intent-level, for example:

```text
spool_list_connectors
spool_test_connection
spool_discover_source
spool_plan_migration
spool_run_migration
spool_inspect_job
spool_pause_job
spool_resume_job
spool_verify_job
spool_get_receipt
```

Granular low-level tools can be exposed only when useful. Tool availability remains state/capability aware.

### 10.4 WebMCP

The website continues using `document.modelContext.registerTool()` with abort-signal lifecycle management. WebMCP remains optional: absence or registration failure must never block SPOOL startup.

Two WebMCP execution classes exist:

- browser-local tools — current CSV/IndexedDB workflow;
- paired-bridge tools — commands proxied to a user-approved local `spoold` pairing.

The page must visually distinguish which execution boundary a tool affects. A WebMCP tool may not silently cross from browser-local execution into daemon/database execution.

## 11. Pairing website to local `spoold`

The production website currently has a strong `connect-src 'none'` local-data guarantee. That invariant remains true for normal browser-only mode.

Bridge support must not be implemented by simply weakening CSP globally.

Preferred product structure:

- browser-only production app remains network-closed for dataset execution;
- local bridge UI is served by `spoold` itself, or a clearly separated bridge-enabled application origin/profile with an explicit pairing flow;
- pairing requires user action and displays the local endpoint, daemon identity, and permissions;
- the daemon validates Origin and pairing token;
- network permissions are scoped to localhost unless a self-hosted endpoint is explicitly configured.

This preserves the ability to truthfully state that normal SPOOL browser execution cannot upload datasets.

## 12. Reference connectors for P1

P1 must prove the abstraction with more than mock adapters.

Required:

### Filesystem connector

- CSV source/target;
- JSON/JSONL source/target;
- streaming/batched reads where practical;
- atomic target write via temp file + rename;
- deterministic verification.

### SQLite connector

- real database connection;
- table discovery;
- schema/type introspection;
- paginated/batched reads;
- transaction-aware writes;
- insert/upsert strategy where supported by the selected key model;
- row-count and sample/hash verification;
- rollback through transaction before commit where applicable.

SQLite gives CI a real database connector without requiring an external service and proves the connector contract before Postgres/MySQL are added.

## 13. Policy and approvals

Every plan carries a risk classification.

Examples requiring explicit approval by default:

- DROP/TRUNCATE;
- destructive target recreation;
- overwriting a non-empty destination;
- key-changing updates;
- migrations without a rollback or isolation strategy when destination mutation is irreversible;
- remote execution/data egress not already authorized in connector policy.

Read/discovery operations remain read-only.

The daemon supports a policy file for CI that can pre-authorize bounded classes of operations. A policy cannot authorize arbitrary executable code because SPOOL does not expose such an execution primitive.

## 14. Failure and recovery

Failures are typed and persist enough evidence to resume safely.

A resumable job records:

- source cursor/snapshot assumptions;
- plan revision;
- destination commit/checkpoint boundary;
- connector version;
- retryability classification.

Resume is allowed only if connector and source/target invariants still match. Otherwise SPOOL fails closed and requires re-plan/restart.

Retries use bounded exponential backoff only for connector-declared transient failures. Validation, permission, schema drift, and destructive-policy errors are not blindly retried.

## 15. Observability

Local mode writes structured local logs and optional OpenTelemetry-compatible traces. Self-hosted mode can export traces/metrics when explicitly configured.

Required dimensions:

- job/plan/receipt IDs;
- connector and operation;
- rows/bytes processed;
- checkpoint progression;
- retries;
- validation rejects;
- verification results;
- duration.

Secrets and raw rows are excluded from default logs/traces.

## 16. Backward compatibility

The existing web CSV workflow remains functional throughout P1.

Existing WebMCP tool names and command-kernel behavior are not removed without a compatibility layer/versioned transition.

Core extraction is done by moving generic logic behind interfaces, not by rewriting the product from scratch.

## 17. Testing strategy

P1 requires all of the following before release:

### Unit

- connector contract validation;
- plan serialization/hash stability;
- secret redaction;
- policy evaluation;
- job/receipt state machine;
- MCP/API envelope validation.

### Integration

- real filesystem -> SQLite migration;
- real SQLite -> filesystem migration;
- SQLite -> SQLite migration with target transaction;
- pause/resume checkpoint;
- process restart recovery;
- schema drift failure;
- invalid credential/config failure;
- destructive-plan approval gate;
- receipt verification.

### Interface parity

The same prepared migration must produce equivalent terminal state when initiated through:

- direct command service;
- CLI;
- HTTP API;
- MCP stdio.

### Security

- daemon cannot bind publicly by default;
- unauthenticated/pairing-invalid browser request rejection;
- Origin checks;
- path traversal protection;
- secret values absent from logs, receipts, inspect responses, and errors;
- no arbitrary command/code execution primitive;
- network egress is attributable to configured connectors only.

### Existing release gate

All current browser, WebMCP, transform, migration, worker, CSP, build, and static checks must remain green.

## 18. P1 success criteria

P1 is complete only when a developer can perform this real workflow:

```text
spool connect add source --type sqlite --database ./legacy.db
spool connect add target --type filesystem --path ./out
spool plan --source source:customers --target target:customers.jsonl --outcome database_ready
spool run <plan>
spool status <job>
spool receipt <job>
```

and an MCP client can perform the equivalent workflow through intent-level tools, with the same plan/job/receipt identities and terminal verification.

It must also support the inverse real workflow (file -> SQLite) and survive a process restart at a durable checkpoint.

No demo-only connector counts toward this criterion.

## 19. Release sequence

1. Extract runtime-neutral core contracts without breaking the web app.
2. Add P1 connector interface and real filesystem/SQLite adapters.
3. Add durable job/receipt store for daemon execution.
4. Add `spoold` local server and strict local security defaults.
5. Add CLI.
6. Add MCP stdio.
7. Add versioned HTTP API and Streamable HTTP MCP for self-hosted mode.
8. Prove interface parity and recovery.
9. Add local bridge UI/pairing as a separate explicitly network-enabled surface.
10. Only then add remote production connectors in P2.

## 20. Design principle

SPOOL should not win by listing the most integrations. It should win by making a migration intent execute safely across real systems through one verifiable protocol:

`intent -> discover -> plan -> approval boundary -> execute -> verify -> receipt`

Every new connector, UI, API, MCP client, or agent integration must fit that contract instead of creating a parallel workflow.
