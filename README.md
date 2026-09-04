# SPOOL

**A local-first Autopilot for deterministic data migrations, built around Temporal WebMCP.**

SPOOL turns a messy CSV into a typed, validated output without making a human or an agent micromanage a long ETL workflow. The default interaction is deliberately small:

`Add source → choose outcome → Run Autopilot → review only real ambiguities → export`

Behind that simple surface, the website owns workflow memory and orchestration: profiling, schema inference, deterministic mapping generation, dry-run validation, bounded repair policy, Worker execution, checkpoint recovery, quality verification and result lineage.

## Product surfaces

The public product and the migration Studio are intentionally separated:

- `/` — product overview and the problem SPOOL solves
- `/autopilot` — what SPOOL automates and where it refuses to guess
- `/how-it-works` — end-to-end migration journey
- `/webmcp` — Temporal WebMCP and site-owned orchestration
- `/benchmarks` — measured engine/tool-surface evidence
- `/docs` — concise product/technical documentation
- `/studio` — durable local migration dashboard
- `/studio/new` — source + outcome; the primary setup surface
- `/studio/mission` — autonomous run state and only the decisions that need attention
- `/studio/results` — output, quality, lineage and exports

Low-level target schema, transform IR, checkpoint and runtime controls remain available under **Advanced diagnostics** rather than being required in the normal workflow.

## Autopilot pipeline

Internally, one `run_autopilot` mission drives:

`PROFILE → INFER → PLAN → DRY RUN → ASSESS → EXECUTE → VERIFY`

SPOOL automatically generates a target contract and constrained transform IR when evidence is strong enough. Ambiguous or destructive choices fail closed into `needs_attention`; the user resolves only those bounded decisions and the mission continues automatically.

For database-ready migrations, semantic fields that are mostly parseable can be promoted from a dirty source string column to `number`, `date`, or `boolean`. Rows that cannot satisfy the typed contract become grouped quality violations rather than being silently coerced.

## Temporal WebMCP

Most agentic sites expose a permanent tool catalog and expect the model to remember which operations are legal. SPOOL makes **tool topology part of application state** and adds site-owned orchestration on top.

The agent-facing happy path can be as small as:

`inspect_workspace → run_autopilot → inspect_mission → inspect_result/export`

Only phase-valid tools remain registered. Stale registrations are removed with `AbortSignal`. Human UI actions and WebMCP execution callbacks invoke the same command kernel; there is no second agent-only business-logic path.

## What is real

- Local CSV parsing with quote/CRLF handling, unsafe/duplicate-header rejection and hard row/column/cell limits.
- Header-only files are rejected before an existing active migration is interrupted.
- Typed target schemas enforced on every output row.
- Constrained deterministic transformation IR; no `eval`, `Function` or arbitrary model-generated code execution.
- Browser Worker execution with job/revision/sequence isolation.
- IndexedDB persistence for source, output, mission metadata and checkpoints.
- Autopilot refresh recovery: a valid interrupted Autopilot mission resumes from its durable checkpoint when reopened; manual migrations remain explicitly recoverable.
- Mapping revision changes force replay from row zero so a completed result contains one transform revision.
- Grouped violations with bounded samples rather than unbounded row dumps to an agent.
- Spreadsheet-formula neutralization on CSV export.
- Native `document.modelContext.registerTool()` integration when WebMCP is supported.
- A deterministic 25k-row demo containing real dirty fee/date values; success is not mocked.
- Production CSP with `connect-src 'none'`; the dataset data plane stays in the browser.

## Run locally

SPOOL has no runtime package dependencies.

```bash
npm ci --ignore-scripts
npm run check
python3 -m http.server 8765
```

Open `http://localhost:8765`, choose **Studio → New migration**, then **Try 25k-row example → Database-ready → Run Autopilot**. SPOOL profiles, plans, dry-runs and executes the migration without manual schema or mapping commands.

## Verification

```bash
npm test
npm run build
npm run benchmark
node scripts/static-check.js
npm run check
```

The benchmark report is regenerated into `benchmarks/latest.json` and `docs/BENCHMARKS.md`. Measurements are local deterministic engine/tool-definition measurements, not universal LLM-success claims.

A Chromium smoke harness is included at `scripts/browser-smoke.py`. Managed execution environments that block browser networking are reported as an environment limitation rather than converted into a fake browser pass.

## Architecture

```text
 Public product routes                 Studio routes
 overview / docs / proof           source + outcome / mission / results
             │                                  │
             └────────────────┬─────────────────┘
                              ▼
                       Command Kernel
                         │         ▲
                  Autopilot        │ WebMCP callbacks
             profile/plan/dry-run  │
                         │         │
                         ▼         │
                    Temporal Registry
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
          IndexedDB             Worker Runtime
      mission/source/output       deterministic IR
      checkpoints/lineage       + schema validation
```

See `docs/ARCHITECTURE.md`, `docs/WEBMCP.md`, `docs/THREAT_MODEL.md`, `docs/BENCHMARKS.md` and `docs/DEMO_SCRIPT.md`.

## Privacy

The production app does not require a dataset API, analytics endpoint, hosted LLM, account system or database service. Static assets are served by Vercel; migration data stays local to the browser.

## License

MIT
