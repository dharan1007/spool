# SPOOL Production Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SPOOL revenue-ready for its proven local-first CSV scope and build the first production-safe SQLite execution path with exact reconciliation, shared command semantics and deployable release evidence.

**Architecture:** Preserve the browser Studio as a strict local-first data plane. Add release provenance and browser gating around the existing static product, then introduce a Node local runner with connector contracts, source snapshots, deterministic batch identity, SQLite atomic target ledger, reconciliation, fencing, verification and receipts. CLI/agent surfaces must call the same command-service boundary rather than duplicating execution logic.

**Tech Stack:** JavaScript ES modules, Node.js >=22, Node test runner, browser module Worker/IndexedDB, Node built-in SQLite where available, GitHub Actions, Vercel static deployment.

**Spec:** `docs/superpowers/specs/2026-09-09-production-monetization-design.md`

## Global Constraints

- Keep the secure Studio local-first and retain its no-network data-plane CSP.
- No arbitrary model-generated code against migration data.
- All ambiguous/destructive behavior fails closed.
- UI/CLI/MCP/daemon execution must converge on shared command/service semantics.
- Never serialize resolved credentials into plans, checkpoints, receipts, browser state or logs.
- A connector capability is a test-backed security/reliability boundary, not documentation.
- Never claim production database migration until the connector conformance and crash-fault gates prove it.

---

### Task 1: Release provenance and browser gate

**Files:**
- Modify: `scripts/build-dist.js`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Create: `tests/release-provenance.test.js`
- Create: `.github/workflows/production-smoke.yml`
- Create: `docs/RELEASE_PROCESS.md`

**Produces:** deterministic `dist/release.json`, CI browser smoke gate, documented source-to-production contract.

- [ ] Write a failing test proving the build emits release metadata from `SPOOL_RELEASE_VERSION`, `SPOOL_COMMIT_SHA` and `SPOOL_BUILD_TIME` without silently inventing a commit identity.
- [ ] Verify the test fails on current main.
- [ ] Implement deterministic release-manifest generation in the build script.
- [ ] Run release-provenance and existing build tests.
- [ ] Add browser smoke to `npm run check:browser` and the release workflow.
- [ ] Add a post-deploy workflow/script that runs `scripts/browser-smoke.py` against the canonical production URL.
- [ ] Document rollback/promotion semantics and commit the slice.

### Task 2: Migration torture corpus and canonical customer fixture

**Files:**
- Create: `fixtures/migration-cases/**`
- Create: `tests/migration-corpus.test.js`
- Create: `examples/crm-export/**`
- Modify: `README.md`
- Modify: `docs/BENCHMARKS.md` only if evidence requires it

**Produces:** deterministic regression corpus for locale numbers, dates, booleans, headers, malformed CSV and formula-safe export plus a real engine-backed CRM example.

- [ ] Write failing corpus tests for each ambiguity/security class.
- [ ] Verify failures correspond to missing fixture/behavior, not test setup.
- [ ] Add fixtures and only the minimal parser/transform changes required to preserve deterministic fail-closed semantics.
- [ ] Add canonical CRM source/expected-output metadata and regression test using the production command path.
- [ ] Run full `npm run check`.

### Task 3: Customer-safe error taxonomy and storage preflight

**Files:**
- Modify: `src/core/errors.js`
- Modify: `src/core/command-kernel.js`
- Modify: `src/storage/indexeddb.js`
- Modify: `src/app.js`
- Create: `tests/errors-contract.test.js`
- Create: `tests/storage-failure.test.js`

**Produces:** stable SPOOL error codes, recoverability/next-action metadata, quota/preflight failures that cannot create false COMPLETE state.

- [ ] Write failing tests for stable structured error envelopes.
- [ ] Write failing tests for quota/storage write rejection before COMPLETE.
- [ ] Implement error registry/envelope and storage preflight/commit failure propagation.
- [ ] Add UI copy for 50 MB boundary and recoverable storage failures.
- [ ] Run kernel/storage/UI tests and full check.

### Task 4: Commercial documentation boundary

**Files:**
- Create: `docs/COMMERCIAL_SUPPORT.md`
- Create: `docs/DATA_HANDLING.md`
- Create: `docs/TERMS_TEMPLATE.md`
- Create: `docs/PRIVACY_TEMPLATE.md`
- Modify: `SUPPORT.md`
- Modify: `README.md`

**Produces:** accurate operational/support/data-handling documentation without pretending templates are jurisdiction-specific legal advice.

- [ ] Document private support intake and severity model.
- [ ] Document that customer rows stay local in Studio and what metadata may be shared during support.
- [ ] Add template legal documents clearly marked for counsel review.
- [ ] Remove the stale “no paid support” statement once commercial support path exists.

### Task 5: Connector contract and source snapshot identity

**Files:**
- Create: `src/connectors/contract.js`
- Create: `src/connectors/source-snapshot.js`
- Create: `tests/connector-contract.test.js`
- Create: `tests/source-snapshot.test.js`

**Produces:** validated connector descriptors/capabilities and deterministic file snapshot identity.

- [ ] Write failing tests for source/target contract validation and capability allowlist.
- [ ] Write failing tests showing changed file content/size identity invalidates resume.
- [ ] Implement strict connector contract types as runtime validators/frozen records.
- [ ] Implement deterministic snapshot hashing and comparison.
- [ ] Run connector/snapshot tests.

### Task 6: Deterministic batch identity and checkpoint binding

**Files:**
- Create: `src/execution/batch-identity.js`
- Create: `src/execution/checkpoint.js`
- Create: `tests/batch-identity.test.js`
- Create: `tests/checkpoint-binding.test.js`

**Produces:** stable batch IDs over migration/plan/snapshot/revision/range/target and fail-closed resume binding.

- [ ] Write failing tests proving same logical batch -> same ID and any semantic change -> different ID.
- [ ] Write failing test for `SOURCE_CHANGED` on checkpoint/snapshot mismatch.
- [ ] Implement canonical hash identity and checkpoint validator.
- [ ] Run execution identity tests.

### Task 7: SQLite target ledger and exact reconciliation

**Files:**
- Create: `src/connectors/sqlite/target.js`
- Create: `src/connectors/sqlite/ledger.js`
- Create: `src/connectors/sqlite/schema.js`
- Create: `tests/sqlite-target.test.js`
- Create: `tests/sqlite-reconciliation.test.js`

**Produces:** atomic migrated-row + ledger transaction and `COMMITTED_EXACT | NOT_COMMITTED | CONFLICT | INDETERMINATE` reconciliation.

- [ ] Write failing test that writes rows and ledger atomically.
- [ ] Write failing test that exact replay does not duplicate rows.
- [ ] Write failing test that same batch ID with different payload is `CONFLICT`.
- [ ] Implement ledger schema and atomic commit.
- [ ] Implement exact reconciliation evidence checks.
- [ ] Run SQLite tests.

### Task 8: Commit-before-checkpoint crash recovery

**Files:**
- Create: `src/execution/migration-runner.js`
- Create: `tests/crash-recovery.test.js`

**Produces:** restart semantics that reconcile target before replaying an uncertain batch.

- [ ] Write fault-injection test that terminates after target commit and before checkpoint persistence.
- [ ] Verify it fails with duplicate/uncertain behavior before implementation.
- [ ] Implement reconcile-before-replay state transition.
- [ ] Prove zero duplicate rows and correct checkpoint advancement.

### Task 9: Lease/fencing and destructive approval binding

**Files:**
- Create: `src/execution/lease-store.js`
- Create: `src/platform/approval.js`
- Modify: `src/platform/policy.js`
- Create: `tests/fencing.test.js`
- Create: `tests/approval-binding.test.js`

**Produces:** monotonic fencing tokens and approvals cryptographically/semantically bound to a specific plan/revision/target/source snapshot/effects.

- [ ] Write stale-runner rejection test.
- [ ] Write approval invalidation tests for target, plan revision and source snapshot changes.
- [ ] Implement lease/fence record and approval identity record.
- [ ] Integrate policy evaluation with bound approval evidence.

### Task 10: Credential broker and filesystem containment

**Files:**
- Create: `src/daemon/credential-broker.js`
- Create: `src/platform/path-policy.js`
- Create: `tests/credential-broker.test.js`
- Create: `tests/path-policy.test.js`

**Produces:** short-lived secret resolution and allow-root/realpath containment for file/SQLite targets.

- [ ] Write failing tests proving secrets never appear in serialized connector refs/results.
- [ ] Write traversal/symlink escape tests.
- [ ] Implement credential broker around existing typed env secret refs.
- [ ] Implement canonical path allow-root checks.

### Task 11: Verification and canonical receipt

**Files:**
- Create: `src/execution/verify.js`
- Create: `src/execution/receipt.js`
- Create: `tests/verification.test.js`
- Create: `tests/receipt.test.js`

**Produces:** row-accounting verification and deterministic hashed migration receipt.

- [ ] Write failing row-accounting and ledger-completeness tests.
- [ ] Write deterministic receipt-hash tests.
- [ ] Implement verification policy checks and canonical receipt construction.
- [ ] Run verification/receipt tests.

### Task 12: `spoold` command service and CLI

**Files:**
- Create: `src/daemon/command-service.js`
- Create: `src/daemon/spoold.js`
- Create: `src/cli/spool.js`
- Modify: `package.json`
- Create: `tests/command-service.test.js`
- Create: `tests/cli.test.js`

**Produces:** one local execution service and staged CLI operations: inspect, plan, dry-run, run, status, resume, verify, receipt.

- [ ] Write command-service tests that prove all mutation passes through policy/approval/runner boundaries.
- [ ] Write CLI contract tests around command parsing and exit codes.
- [ ] Implement minimal daemon and CLI without a second migration engine.
- [ ] Run command/CLI tests.

### Task 13: SQLite conformance and security fault suite

**Files:**
- Create: `tests/conformance/sqlite-conformance.test.js`
- Create: `tests/conformance/sqlite-faults.test.js`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Produces:** executable evidence for every SQLite production capability.

- [ ] Test atomic ledger, idempotency, reconciliation, snapshot binding, fencing, credential isolation, filesystem containment and verification.
- [ ] Add disk/permission/busy/schema-change cases that can be deterministically exercised in CI.
- [ ] Gate `sqliteProductionReady` claim on the conformance suite.

### Task 14: Product surface, docs and rollout copy

**Files:**
- Modify: `src/app.js`
- Modify: `styles.css`
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Create: `docs/MIGRATION_SERVICES.md`

**Produces:** truthful outcome-first messaging, explicit limits, commercial assessment CTA and capability status without weakening Studio CSP.

- [ ] Add capability/status UI and 50 MB boundary.
- [ ] Add external/plain-link commercial contact route compatible with strict Studio security design.
- [ ] Update roadmap to mark only proved connector milestones complete.

### Task 15: PR, CI, merge and production deployment

**Files:** repository-wide verification only.

**Produces:** reviewed merge with fresh CI evidence and production deployment whose release manifest matches merged main.

- [ ] Run/fetch all GitHub Actions checks for the feature branch/PR.
- [ ] Review PR diff against this plan and spec; resolve any mismatch.
- [ ] Merge only if release gate + CodeQL + browser/conformance checks are green.
- [ ] Deploy merged main to Vercel production.
- [ ] Fetch production `/release.json` and compare commit SHA to merged main.
- [ ] Run production browser smoke and inspect runtime errors.
- [ ] Only then update README/roadmap readiness claims to the exact verified gate achieved.

## Deferred until SQLite Gate B is proved

PostgreSQL, streaming/OPFS enterprise-scale ingestion, managed control plane, organization/RBAC/SSO, billing metering and enterprise SLA automation remain separate follow-on subprojects. They must reuse the connector/runner/conformance boundaries built here rather than being implemented in parallel with an unproved SQLite safety model.
