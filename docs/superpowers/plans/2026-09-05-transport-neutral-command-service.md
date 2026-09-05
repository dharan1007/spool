# Transport-Neutral Command Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one transport-neutral daemon command service that exposes the already-approved P1 connector, plan, runner, job, and receipt capabilities without duplicating migration business logic or leaking secrets/raw rows.

**Architecture:** `SpoolCommandService` is a thin orchestration boundary over `ConfigStore`, `ConnectorRegistry`, `SharedMigrationRunner`, and `SQLiteJobStore`. It accepts connection names plus typed command inputs, resolves only stored non-secret connector config, validates connection/connector type agreement, creates capability-bound plans from the registry manifests, delegates execution to the existing shared runner, and projects all externally returned jobs/receipts/errors through the existing public DTO boundary. This increment deliberately does not add HTTP, stdio, CLI, MCP, WebMCP pairing, sockets, listeners, or a second execution engine.

**Tech Stack:** Node.js 22+, ES modules, existing deterministic SPOOL core, existing ConnectorRegistry/ConfigStore/SharedMigrationRunner/SQLiteJobStore, node:test.

**Spec:** `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md`

## Global Constraints

- Preserve the existing browser CSV/WebMCP workflow unchanged.
- No arbitrary SQL, JavaScript, shell, or command execution primitive.
- No raw dataset rows in command responses.
- No resolved credential values in command responses, persisted plans, jobs, receipts, or errors.
- Existing connector capability and capability-bound-plan enforcement remains authoritative.
- All migration execution must delegate to `SharedMigrationRunner`; the command service must not implement a write loop.
- No network listener or production deployment in this increment.

---

### Task 1: Define command-service behavior with failing tests

**Files:**
- Create: `tests/command-service.test.js`

**Interfaces:**
- Consumes: `ConfigStore`, `ConnectorRegistry`, `FilesystemConnector`, `SQLiteConnector`, `SQLiteJobStore`, `createCapabilityBoundMigrationPlan`, `SharedMigrationRunner`.
- Produces test contract for `SpoolCommandService` methods: `listConnectors()`, `listConnections()`, `putConnection()`, `testConnection()`, `createPlan()`, `runMigration()`, `inspectJob()`, `getReceipt()`.

- [ ] Write tests proving connector manifests are returned without connector instances.
- [ ] Write tests proving stored connection projections expose name/type/config metadata but never resolved secrets or raw secret material.
- [ ] Write tests proving `testConnection(name)` opens the named connector, validates type agreement, returns bounded health metadata, and closes the connector.
- [ ] Write a real filesystem -> SQLite test where `createPlan()` binds current connector capabilities and `runMigration()` returns public job/receipt DTOs for a verified COMPLETE job.
- [ ] Write tests proving `inspectJob()` and `getReceipt()` return public projections and reject unknown IDs.
- [ ] Write a fail-closed test for connection type / plan connector mismatch before runner execution.
- [ ] Run `node --test tests/command-service.test.js`; expected RED because `src/daemon/command-service.js` does not exist.
- [ ] Commit the RED test definition.

### Task 2: Implement the command service as an orchestration-only boundary

**Files:**
- Create: `src/daemon/command-service.js`

**Interfaces:**
- Constructor: `new SpoolCommandService({ configStore, registry, jobStore, runner })`.
- `listConnectors(): Promise<Array<ConnectorManifest>>`.
- `listConnections(): Promise<Array<PublicConnectionDescriptor>>` where secret refs are represented only as sorted reference names, never values.
- `putConnection({ name, type, config, secretRefs }): Promise<PublicConnectionDescriptor>` delegates storage validation to `ConfigStore`.
- `testConnection({ name }): Promise<{name,type,ok,health}>` returns redacted/bounded connector health and always closes the connector.
- `createPlan({ planInput, sourceConnection, targetConnection, requirements }): Promise<MigrationPlan>` obtains manifests from the registry, validates descriptor type agreement, and delegates to `createCapabilityBoundMigrationPlan()`.
- `runMigration({ plan, sourceConnection, targetConnection, jobId }): Promise<{job,receipt}>` validates connection/plan agreement, delegates to `SharedMigrationRunner.run()`, and returns `projectPublicJob()` / `projectPublicReceipt()` only.
- `inspectJob({ jobId }): Promise<PublicJob>` delegates to `SQLiteJobStore.load()` and projects it.
- `getReceipt({ receiptId?, jobId? }): Promise<PublicReceipt>` resolves a receipt ID from an explicit ID or job and delegates to `loadReceipt()`.

- [ ] Add strict dependency/method validation in the constructor.
- [ ] Add request-shape/name validation and a single private connection resolver that fails `CONNECTION_NOT_FOUND` and `CONNECTION_TYPE_MISMATCH` before connector execution.
- [ ] Add connection projection that includes `secretRefNames` only.
- [ ] Add bounded health projection using recursive redaction plus durable-clone validation; do not return connector-native objects or arbitrary Error strings.
- [ ] Implement plan creation by delegating to `createCapabilityBoundMigrationPlan()` with registry manifests.
- [ ] Implement run delegation; do not transform/read/write/verify inside this file.
- [ ] Implement job and receipt lookup using existing public DTO projectors.
- [ ] Run `node --test tests/command-service.test.js`; expected GREEN.
- [ ] Commit implementation.

### Task 3: Full compatibility and release verification

**Files:**
- Modify only if a test demonstrates a real compatibility defect; otherwise no production changes.

- [ ] Run `npm ci --ignore-scripts` and confirm zero reported dependency vulnerabilities.
- [ ] Run `npm run check` and require all tests, build, benchmark, and `scripts/static-check.js` to pass.
- [ ] Confirm existing browser/WebMCP/CSP/static checks remain green.
- [ ] Confirm PR #3 remains draft, open, mergeable, and unmerged.
- [ ] Inspect current Vercel production deployment and 24-hour runtime errors; do not deploy this daemon-only increment.
