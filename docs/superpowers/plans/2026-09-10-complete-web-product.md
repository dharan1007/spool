# SPOOL Complete Web Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the current complete SPOOL product to the canonical website, with the working Browser Studio plus first-class local-runner, examples, security, and services routes, then prove the deployed SHA matches the merged source.

**Architecture:** Keep the existing single-page static browser application and constrained CSP. Extend the existing route/page system in `src/app.js` and visual system in `styles.css`; do not create a second frontend or add hosted execution. Preserve the customer-local Gate-B runner and expose its real commands/evidence as documentation/product surfaces.

**Tech Stack:** Vanilla ES modules, CSS, IndexedDB/Web Workers, Node.js 22, better-sqlite3 local runner, GitHub Actions, CodeQL, Vercel static deployment.

**Spec:** `docs/superpowers/specs/2026-09-10-complete-web-product-design.md`

## Global Constraints

- Preserve production CSP including `connect-src 'none'`.
- No analytics, external runtime fetches, payment SDKs, hosted raw-row ingestion, or browser-to-`spoold` bridge.
- Gate-B execution remains local filesystem CSV -> existing ordinary SQLite table, insert-only.
- Do not claim PostgreSQL/MySQL, upsert/replace/delete/truncate, virtual tables, triggered SQLite targets, or unlimited browser inputs.
- Production acceptance requires exact deployed `/release.json` SHA match plus live browser smoke.

---

### Task 1: Website product-route contract

**Files:**
- Modify: `tests/ui-contract.test.js`
- Modify: `src/app.js`

**Interfaces:**
- Produces public routes `/local-runner`, `/examples`, `/security`, `/services` in the same SPA router.

- [ ] Write failing UI-contract assertions for the four routes, their page titles, and top navigation/product links.
- [ ] Run the UI test and verify failure is due to missing routes/content.
- [ ] Add the route constants, page mappings, titles, and navigation entries.
- [ ] Re-run UI tests and keep existing Studio routes green.

### Task 2: Complete-product homepage

**Files:**
- Modify: `tests/ui-contract.test.js`
- Modify: `src/app.js`
- Modify: `index.html`

**Interfaces:**
- Homepage distinguishes Browser Studio and Gate-B local runner and never labels the current site/product as merely a demo.

- [ ] Add failing assertions for complete-product identity and two-surface explanation.
- [ ] Update document metadata/title and homepage hero/product architecture sections.
- [ ] Add direct links to Studio and Local Runner.
- [ ] Verify UI/static tests.

### Task 3: Local Runner route

**Files:**
- Modify: `tests/ui-contract.test.js`
- Modify: `src/app.js`
- Modify: `styles.css`

**Interfaces:**
- Page documents exact Gate-B support matrix and actual CLI staged workflow without implying browser execution.

- [ ] Add failing assertions for source snapshot, target preflight/contract, approval, fencing, reconciliation, verification, receipt, `spoold`, and explicit unsupported targets/strategies.
- [ ] Implement `/local-runner` page using existing visual primitives plus focused command/support panels.
- [ ] Add responsive styles needed by the new page.
- [ ] Verify UI/static tests.

### Task 4: Examples route

**Files:**
- Modify: `tests/ui-contract.test.js`
- Modify: `src/app.js`
- Reference: `examples/crm-export/*`
- Reference: `tests/crm-example.test.js`

**Interfaces:**
- Page truthfully reflects the checked-in CRM fixture and its deterministic expected outcomes.

- [ ] Add failing assertions for CRM source/target/request references, 5 source records, 3 valid, 2 rejected, ambiguous-date rejection, and receipt/ledger evidence.
- [ ] Implement `/examples` with fixture walkthrough and exact evidence language.
- [ ] Verify UI and canonical CRM tests.

### Task 5: Security route

**Files:**
- Modify: `tests/ui-contract.test.js`
- Modify: `src/app.js`
- Reference: `SECURITY.md`, `docs/THREAT_MODEL.md`, `docs/DATA_HANDLING.md`

**Interfaces:**
- Page separates browser CSP/data-plane guarantees from local-runner target mutation guarantees.

- [ ] Add failing assertions for `connect-src 'none'`, no arbitrary generated JS, path containment, source/target binding, approvals, fencing, reconciliation, verification, and receipts.
- [ ] Implement `/security` with browser/local-runner trust-boundary matrix and fail-closed states.
- [ ] Verify UI/security/static tests.

### Task 6: Services route

**Files:**
- Modify: `tests/ui-contract.test.js`
- Modify: `src/app.js`
- Reference: `docs/SOLO_BUILDER_LAUNCH.md`, `docs/MIGRATION_SERVICES.md`

**Interfaces:**
- Page exposes four current paid outcomes under Dharan Tej Reddy Poduvu as individual solo builder, with metadata-only assessment intake and no payment gateway.

- [ ] Add failing assertions for the four services, solo-provider boundary, and metadata-only intake language.
- [ ] Implement `/services` with outcome/deliverable cards and current capability fit.
- [ ] Keep private payment identifiers out of the bundle.
- [ ] Verify UI/static tests.

### Task 7: Build and release contract

**Files:**
- Modify: `tests/build-dist.test.js` if needed
- Modify: `scripts/browser-smoke.py` if needed
- Modify: `.github/workflows/production-smoke.yml` if needed

**Interfaces:**
- Built artifact must deep-link every new route and production smoke must validate release identity.

- [ ] Add failing build/deep-link assertions for the new routes if current rewrite tests do not cover them.
- [ ] Ensure browser smoke can visit at least one new product route and return to Studio without runtime errors.
- [ ] Ensure production smoke requires `/release.json` commit equality.
- [ ] Run release gate via PR event.

### Task 8: PR verification and merge

**Files:**
- All changed files.

- [ ] Open final PR from `release/complete-web-product-20260910` to `main`.
- [ ] Require release-gate success, CodeQL success, and Linux/Windows/macOS SQLite conformance.
- [ ] Review changed files for unsupported claims or CSP/network regressions.
- [ ] Merge with expected head SHA.
- [ ] Verify actual merged `main` SHA independently.

### Task 9: Exact-SHA production deployment

**Files/Systems:**
- GitHub Actions release artifact
- Vercel project `spool-webmcp`
- Canonical domain `spool-webmcp.vercel.app`

**Interfaces:**
- Live `/release.json` must report the exact merged `main` SHA.

- [ ] Build the static artifact with `SPOOL_COMMIT_SHA=<merged-main-sha>`.
- [ ] Deploy the complete artifact to Vercel production, not a partial overlay.
- [ ] Fetch canonical `/release.json` and require exact commit equality.
- [ ] Verify `/`, `/local-runner`, `/examples`, `/security`, `/services`, `/studio/new`, `/studio/results` deep links.
- [ ] Run production browser smoke against canonical domain.
- [ ] Inspect Vercel production logs/errors and reject release on application failures.

### Task 10: Final production acceptance

- [ ] Confirm canonical domain no longer serves the September 4 title/metadata.
- [ ] Confirm current product pages and Studio are live.
- [ ] Confirm CSP remains restrictive and no dataset-network path was introduced.
- [ ] Record final merged SHA and deployment identity in the final report.