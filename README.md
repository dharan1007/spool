# SPOOL

**Local-first autonomous data migrations: dirty data in, typed and validated data out.**

SPOOL profiles messy CSV data, infers a target schema, generates a constrained deterministic transform plan, dry-runs it, executes it with checkpoint recovery, verifies the result, and preserves lineage — without uploading the dataset to an application backend.

[**Try SPOOL**](https://spool-webmcp.vercel.app/) · [How it works](docs/ARCHITECTURE.md) · [Benchmarks](docs/BENCHMARKS.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](ROADMAP.md)

[![release-gate](https://github.com/dharan1007/spool/actions/workflows/ci.yml/badge.svg)](https://github.com/dharan1007/spool/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## See the outcome first

```text
messy CSV
   ↓
PROFILE
   ↓
INFER TARGET CONTRACT
   ↓
PLAN DETERMINISTIC TRANSFORMS
   ↓
DRY RUN + QUALITY ASSESSMENT
   ↓
EXECUTE WITH CHECKPOINTS
   ↓
VERIFY
   ↓
typed output + violations + lineage
```

The normal interaction is deliberately small:

`Add source → choose outcome → Run Autopilot → review only real ambiguities → export`

SPOOL owns the mechanical migration workflow. It does **not** silently guess through ambiguous or destructive decisions. Those fail closed into a bounded `needs_attention` state.

## Try it in about a minute

1. Open [spool-webmcp.vercel.app](https://spool-webmcp.vercel.app/).
2. Choose **Studio → New migration**.
3. Select **Try 25k-row example**.
4. Choose **Database-ready**.
5. Run **Autopilot**.
6. Inspect the typed result, grouped quality violations, lineage and export.

The included 25k-row example contains real dirty fee/date values; the successful result is produced by the same deterministic engine used by the Studio, not by mocked output.

## Why SPOOL exists

A data migration is usually much more than copying rows. Real inputs contain locale-dependent numbers, malformed dates, mixed boolean conventions, duplicate or unsafe headers, invalid cells, partial batches and interrupted runs. A generic LLM can suggest transformations, but unrestricted generated code is the wrong trust boundary for a migration engine.

SPOOL separates **inference** from **execution**:

| Problem | SPOOL's boundary |
|---|---|
| Messy source data | Profile and infer structure from bounded evidence |
| Schema conversion | Generate a typed target contract |
| Transformation | Execute a constrained deterministic IR — no `eval` or arbitrary generated code |
| Ambiguity | Stop and request a bounded decision instead of guessing |
| Partial execution | Persist checkpoints and mission state |
| Mapping changes | Replay from row zero so one result never mixes transform revisions |
| Bad rows | Group violations with bounded samples instead of silently coercing them |
| CSV export | Neutralize spreadsheet formulas before export |
| Dataset privacy | Keep the dataset data plane in the browser |

## Measured engine evidence

The checked-in deterministic benchmark currently reports:

| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 7.63 ms | 12.46 ms | 80,241 | 999 | 1 |
| 10,000 | 37.45 ms | 70.77 ms | 141,300 | 9,982 | 18 |
| 50,000 | 138.29 ms | 334.26 ms | 149,584 | 49,910 | 90 |

SPOOL's temporal tool registry also exposes 4.75 active tools / 1,658 serialized definition bytes on average across the measured workflow phases versus a permanent 23-tool / 7,963-byte catalog for the same tool set — a 79.3% active-tool reduction and 79.2% serialized-definition reduction.

These are **local deterministic engine and serialized-schema measurements**, not universal claims about model success, tokenization or browser-agent performance. Reproduce them with:

```bash
npm ci --ignore-scripts
npm run benchmark
```

See [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) and [`benchmarks/latest.json`](benchmarks/latest.json) for the generated evidence.

## Autopilot pipeline

A single `run_autopilot` mission drives:

```text
PROFILE → INFER → PLAN → DRY RUN → ASSESS → EXECUTE → VERIFY
```

Semantic string fields that are sufficiently parseable can be promoted to `number`, `date` or `boolean`. Values that cannot satisfy the target contract become explicit quality violations instead of being silently coerced.

## Temporal WebMCP

Most agentic applications expose a permanent catalog and make the caller reason about which tools are currently legal. SPOOL makes **tool topology part of application state**.

The agent-facing happy path can be as small as:

```text
inspect_workspace
→ run_autopilot
→ inspect_mission
→ inspect_result / export
```

Only phase-valid tools remain registered. Stale registrations are removed with `AbortSignal`. Human UI actions and WebMCP callbacks invoke the same command kernel, so there is no separate agent-only business-logic implementation.

Native browser integration uses `document.modelContext.registerTool()` when WebMCP is available. Browsers without that experimental API still use the normal human Studio.

## What is implemented

- Local CSV parsing with quote/CRLF handling, unsafe/duplicate-header rejection and hard row/column/cell limits.
- Header-only rejection before an active migration is interrupted.
- Typed target schemas enforced for every output row.
- Constrained deterministic transformation IR.
- Browser Worker execution with job/revision/sequence isolation.
- IndexedDB persistence for source, output, mission metadata and checkpoints.
- Autopilot refresh recovery from a valid durable checkpoint.
- Revision-aware replay when mappings change.
- Grouped violations with bounded samples.
- Spreadsheet-formula neutralization on CSV export.
- Temporal WebMCP tool registration.
- Deterministic benchmark generation.
- Production CSP with `connect-src 'none'` for the local dataset data plane.

## Product surfaces

- `/` — product overview
- `/autopilot` — automation and ambiguity boundaries
- `/how-it-works` — migration journey
- `/webmcp` — temporal agent surface
- `/benchmarks` — measured evidence
- `/docs` — product and technical documentation
- `/studio` — durable local migration dashboard
- `/studio/new` — source + outcome setup
- `/studio/mission` — autonomous run state and decisions requiring attention
- `/studio/results` — output, quality, lineage and exports

Low-level schema, transform IR, checkpoint and runtime controls remain under **Advanced diagnostics** rather than being required in the normal workflow.

## Run locally

SPOOL has no runtime npm dependencies.

```bash
git clone https://github.com/dharan1007/spool.git
cd spool
npm ci --ignore-scripts
npm run check
npm run serve
```

Open `http://localhost:8765`.

Node.js 22+ is required by the checked-in package contract.

## Verification

```bash
npm test
npm run build
npm run benchmark
node scripts/static-check.js
npm run check
```

A Chromium smoke harness is included at `scripts/browser-smoke.py`. Environments that block browser networking are reported as environment limitations rather than converted into fake passes.

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

Deeper design documents:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/WEBMCP.md`](docs/WEBMCP.md)
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md)

## Contributing

Useful contributions are intentionally scoped so first-time contributors can ship real improvements rather than cosmetic churn. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md), then look for [`good first issue`](https://github.com/dharan1007/spool/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) or [`help wanted`](https://github.com/dharan1007/spool/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).

If you have an ugly real-world migration case that can be shared safely, open a data-case issue. High-value fixtures are one of the best ways to improve SPOOL.

## Roadmap

The public roadmap lives in [`ROADMAP.md`](ROADMAP.md). Priorities are evidence-driven: connector correctness, crash semantics, deterministic reconciliation, migration-case coverage and integration ergonomics come before adding broad but unverifiable feature claims.

## Privacy and security

The production app does not require a dataset API, analytics endpoint, hosted LLM, account system or database service. Static assets are hosted; migration data remains local to the browser for the current product path.

See [`SECURITY.md`](SECURITY.md) and [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) before proposing changes to execution, storage, connectors or agent surfaces.

## Related projects

- [PACT](https://github.com/dharan1007/pact) — transactional safety for consequential agent actions.
- [KATA](https://github.com/dharan1007/kata) — deterministic research automation for humans and agents.
- [FAULTLINE](https://github.com/dharan1007/faultline) — causal reduction of browser failures into reproducible cases.

## License

MIT — see [`LICENSE`](LICENSE).

If SPOOL solves a migration problem you care about, a GitHub star is the simplest way to follow the project and help other data engineers discover it.