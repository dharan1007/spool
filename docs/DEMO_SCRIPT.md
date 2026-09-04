# SPOOL evaluator demo script

This path demonstrates the product and the WebMCP thesis in under three minutes without claiming capabilities that are not measured.

## 0:00–0:20 — Explain the product

Open `/` and state the core outcome: a messy CSV becomes a typed, validated result without forcing a person or agent to micromanage the migration procedure.

Open **How it works** briefly. The visible path is source → outcome → Autopilot → bounded ambiguity only if necessary → verified result. The manual transform machinery is under Advanced diagnostics.

## 0:20–0:45 — Start one Autopilot mission

Open `/studio/new` and click **Try 25k-row example**. Keep **Database-ready** selected and click **Run Autopilot**.

SPOOL now profiles the source, infers typed fields from evidence, creates the target contract, creates constrained transform IR, dry-runs the real engine and starts the Worker. There are no manual schema or mapping commands in this path.

## 0:45–1:15 — Show evidence and agent topology

On `/studio/mission`, show inference confidence/evidence and the high-level mission state. Open Advanced diagnostics only after the simple workflow is clear.

Open `/webmcp` or inspect the live tool list. Explain that `run_autopilot` is available in `SOURCE_READY`, runtime tools replace authoring tools while `RUNNING`, and stale registrations are removed with `AbortSignal`.

Do not claim native WebMCP support in a browser that does not expose `document.modelContext.registerTool`; the Studio works independently of that experimental API.

## 1:15–1:45 — Demonstrate recovery

During a sufficiently large run, refresh the page. An Autopilot mission does not pretend the old Worker survived. SPOOL restores the durable workspace, marks the mission recovering, creates a new Worker and resumes from the persisted checkpoint under the same mapping revision.

For comparison, Advanced/manual runs restore as `PAUSED_RECOVERED` and require an explicit resume.

## 1:45–2:15 — Verify result quality

When complete, open `/studio/results`. Show processed, valid and rejected counts, output sample, grouped quality violations and lineage. The demo intentionally contains malformed values, so exceptions are real engine results rather than fabricated success cards.

Export CSV or JSON. CSV output neutralizes spreadsheet-formula prefixes.

## 2:15–2:40 — Show measured evidence

Open `/benchmarks`. Quote only the values from the current release benchmark. The benchmark measures deterministic transformation/target-validation throughput and serialized WebMCP tool-definition surface.

Do **not** turn those measurements into claims about universal LLM reliability, token savings or agent success rate. A flat-vs-temporal controlled agent experiment is a separate future empirical test.

## 2:40–2:55 — Close

End on the product distinction:

> SPOOL makes the website own both workflow memory and workflow orchestration. The human or agent states the desired outcome; the site exposes only capabilities that are valid for the current state.
