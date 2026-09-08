# AGENTS.md — SPOOL

This file is the fast contract for coding agents working in this repository.

## Product

SPOOL is a local-first deterministic data-migration system. The browser product profiles CSV data, infers a typed target contract, plans constrained transforms, dry-runs, executes in a Worker, verifies output and persists recovery state. WebMCP exposes state-valid operations through the same command kernel used by the human UI.

## Non-negotiable invariants

- Never add arbitrary generated-code execution (`eval`, `new Function`, shell execution) to the migration path.
- Invalid typed output must remain an explicit violation; do not silently coerce it.
- Destructive/material ambiguity fails closed.
- Mapping revisions cannot produce mixed-revision output.
- Resumption must be bound to explicit durable state/checkpoints.
- Current browser dataset contents stay local; do not add dataset telemetry/network upload casually.
- Agent tools must invoke the canonical command/business-logic path rather than bypassing it.
- Do not fabricate browser, benchmark, deployment or connector success.

## Read before changing core behavior

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/THREAT_MODEL.md`
4. `docs/PRODUCTION_AUDIT.md`
5. `docs/WEBMCP.md` for agent-surface work
6. `docs/BENCHMARKS.md` for benchmark work

## Verification

```bash
npm ci --ignore-scripts
npm test
npm run build
npm run benchmark
node scripts/static-check.js
npm run check
```

For browser-path changes, attempt `python3 scripts/browser-smoke.py` when the environment permits local browser networking.

## Change discipline

- Make the smallest change that preserves the product boundary.
- Add a regression fixture/test before or with bug fixes.
- Keep benchmark methodology changes explicit.
- Treat connectors as durability/security boundaries, not convenience wrappers.
- Update README/architecture/security docs when externally observable behavior changes.