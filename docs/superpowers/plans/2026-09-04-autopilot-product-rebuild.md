# SPOOL Autopilot Product Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragile production bootstrap and manual one-page workflow with a reliable same-origin multi-route Autopilot product.

**Architecture:** Preserve the deterministic command kernel, Worker runtime, IndexedDB and transform IR. Add an evidence-backed Autopilot planner and mission metadata, then render separate public/Studio routes from a small route-driven frontend. Deploy ordinary same-origin modules and Worker files with SPA rewrites.

**Tech Stack:** Browser ES modules, Web Workers, IndexedDB, Node 22 test runner, Vercel static hosting, WebMCP.

**Spec:** `docs/superpowers/specs/2026-09-04-autopilot-product-rebuild-design.md`

## Global Constraints

- Dataset processing remains browser-local.
- `connect-src 'none'` remains enforced in production CSP.
- No `eval`, `Function`, arbitrary generated JavaScript, XHR, fetch, WebSocket or analytics.
- Unsafe/destructive inference must fail closed into bounded user decisions.
- Existing granular command kernel remains the source of truth; Autopilot composes it rather than creating a second migration engine.
- Direct Studio/public routes must work on Vercel refresh/deep-link.

---

### Task 1: Evidence-backed Autopilot planner
- Add planner tests first for normalized names, parseability promotion, collision ambiguity and evidence/confidence.
- Implement `src/core/autopilot.js` with deterministic target + mapping planning.

### Task 2: Kernel mission orchestration
- Add kernel tests first for `run_autopilot`, `inspect_mission`, automatic start, and fail-closed ambiguity.
- Persist mission metadata and update completion/error/recovery lifecycle.

### Task 3: Temporal WebMCP mission tools
- Test phase tool surfaces and state contracts.
- Add `run_autopilot`/`inspect_mission` while retaining advanced granular tools where valid.

### Task 4: Route-driven product UI
- Replace monolithic app rendering with Overview, Autopilot, How It Works, WebMCP, Benchmarks, Docs, Studio, New Migration, Mission and Results routes.
- Keep only source + outcome + run in the default setup; move internals to Advanced diagnostics.

### Task 5: Reliable same-origin release
- Replace compressed/blob bootstrap artifacts with ordinary same-origin static modules.
- Add SPA rewrites to `/index.html` without `cleanUrls`.
- Test build output for absence of `DecompressionStream`, blob app import, remote/network primitives, and direct-route config.

### Task 6: Full verification and production deployment
- Run `npm run check` fresh.
- Deploy the exact release to the existing `spool-webmcp` Vercel project.
- Verify `/`, `/autopilot`, `/how-it-works`, `/webmcp`, `/benchmarks`, `/docs`, `/studio`, `/studio/new`, `/studio/mission`, `/studio/results`, all static assets, CSP/security headers, and Vercel runtime errors.
