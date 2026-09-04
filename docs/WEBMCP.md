# WebMCP design

SPOOL uses the imperative browser API when available:

```js
await document.modelContext.registerTool(tool, { signal: controller.signal });
```

WebMCP is an optional capability layer, not an application boot dependency. If the browser does not expose the API—or an experimental implementation rejects registration—Studio remains usable and reports that native registration is unavailable.

## Temporal registration

The `TemporalRegistry` maintains one `AbortController` per active tool. When the domain phase changes, tools not valid in the new phase are aborted and new valid tools are registered. Tools valid in both phases remain registered to avoid needless churn.

The site therefore owns both durable workflow state and the currently legal capability topology.

## Autopilot tool path

At `SOURCE_READY`, an agent can use `run_autopilot` instead of reconstructing schema → mapping → validation → preview → execution sequencing in conversation context. The high-level path is:

`inspect_workspace → run_autopilot → inspect_mission → inspect_result/export`

Granular authoring/runtime commands remain available when their phase makes them legal.

## State contract

Every command response identifies the current phase, job identity, mapping revision and next valid actions. Tool registrations are invalidated when the phase changes, while source fingerprint and target/mapping revisions live in the durable workspace. A stale tool call therefore cannot silently mutate a different workflow phase.

## Context discipline

`inspect_workspace` returns metadata only. `inspect_mission` exposes bounded inference evidence, ambiguity information, progress and quality groups. Source/result rows require explicit bounded sampling tools. Violation inspection returns grouped failure classes with capped examples. User-provided source/result content is marked with `untrustedContentHint` in tool annotations.

## Principal phases

- `EMPTY`: workspace metadata + supported formats.
- `SOURCE_READY`: inspect source, run Autopilot, or explicitly define a target.
- `TARGET_READY` / `MAPPING_DRAFT`: advanced contract/mapping authoring.
- `MAPPING_VALID`: preview/revise/start.
- `RUNNING`: mission/run state, pause and grouped violations.
- `PAUSED` / `PAUSED_RECOVERED`: resume/revise/abort.
- `REPLAYING`: run state/violations/abort only.
- `COMPLETE`: mission/result/quality/export/new migration.

The benchmark in `docs/BENCHMARKS.md` measures tool-definition surface only. It does not claim improved model completion rate without a controlled agent experiment.
