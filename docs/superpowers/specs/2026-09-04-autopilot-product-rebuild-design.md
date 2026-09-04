# SPOOL Autopilot Product Rebuild Design

SPOOL becomes a route-driven product rather than a monolithic workbench. Public routes explain the product and evidence; Studio routes reduce the normal migration flow to source + outcome + Autopilot. Manual schema, mapping IR, runtime and WebMCP details remain available only as Advanced diagnostics.

The runtime keeps the existing deterministic command kernel, Worker execution, IndexedDB persistence and safe transform IR. A new Autopilot planner profiles source rows, produces an evidence-backed target contract and mapping, dry-runs the real engine, and starts execution automatically when confidence is sufficient. Destructive ambiguity fails closed and becomes a bounded `needs_attention` mission instead of silent guessing.

Production deployment must use normal same-origin static assets. It must not reconstruct the app from compressed payload strings, `DecompressionStream`, blob CSS, or dynamic blob imports. Vercel rewrites every non-asset route to `/index.html`, and direct routes such as `/autopilot` and `/studio/mission` must resolve successfully.

The default UX is: add file, choose outcome, run Autopilot, answer only genuine ambiguities, receive verified output. The mission surface exposes planner confidence/evidence, progress, quality and lineage without requiring constant monitoring.
