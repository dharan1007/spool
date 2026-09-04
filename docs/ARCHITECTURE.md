# Architecture

## Product boundary

SPOOL is split into explanatory product routes and a focused Studio. The normal Studio journey is intentionally small: source CSV → desired outcome → Autopilot mission → result. Target schema, transform IR, worker state, checkpoint identity and manual controls are diagnostics, not prerequisites for the common path.

## Command kernel

`src/core/command-kernel.js` is the single mutation boundary. Human controls, Autopilot and WebMCP tools never maintain separate business logic. Commands return a stable envelope with `ok`, phase/revision state, result/error and `nextValidActions`.

## Autopilot planner

`src/core/autopilot.js` profiles source evidence and creates a deterministic target contract plus constrained transform mapping for three bounded outcomes: `database_ready`, `clean_standardize`, and `preserve_contract`.

Database-ready inference can promote a source string to boolean, integer, number or date only when sampled evidence crosses the planner confidence threshold. Destructive naming collisions fail closed into `NEEDS_ATTENTION`; SPOOL does not invent a resolution.

A safe mission executes:

`PROFILE → INFER → PLAN → DRY RUN → ASSESS → EXECUTE → VERIFY`

The dry run uses the same `MigrationEngine`, mapping IR and target validator as the full run.

## State machine

Illegal phase transitions fail closed. Runtime counters maintain `validRows + invalidRows = processedRows`, and completed jobs require `processedRows = totalRows`.

A manual run interrupted by a terminated tab restores as `PAUSED_RECOVERED`. An Autopilot mission restores the same durable checkpoint, validates its persisted revisions, transitions back to `RUNNING`, and starts a new Worker from that checkpoint. SPOOL never claims that a Worker survives a closed tab.

## Durable data plane

`IndexedDbWorkspaceStore` separates compact workflow/mission metadata from source/output chunks. Source chunks are rewritten only when the source fingerprint changes. Output chunks append as progress advances and are cleared when output identity/revision rewinds.

The current UI accepts files up to 50 MB and the parser still materializes the source in browser memory. Whole-file streaming/OPFS is a future scale extension, not a current capability claim.

## Worker protocol

A dedicated module Worker processes bounded chunks. Every message carries `jobId`, mapping `revision` and monotonic `seq`. `WorkerMessageGate` rejects stale jobs, old revisions and out-of-order messages. Kernel runtime callbacks are serialized so IndexedDB writes cannot reorder progress or completion.

## Revision replay

A mapping edited while paused increments `mappingRevision` and sets `needsReplay`. Resume clears old output, transitions through `REPLAYING`, and restarts from row zero. Correctness is favored over incremental patch complexity.

## Release delivery

Production is delivered as ordinary same-origin static assets: `index.html`, `styles.css`, ES modules under `/src`, and the module Worker. The release deliberately does **not** reconstruct the application from compressed JavaScript payload chunks, `DecompressionStream`, or a dynamic blob module import. This removes an unnecessary startup failure boundary and keeps browser execution debuggable.

Vercel uses one SPA rewrite from `/(.*)` to `/index.html`, so direct navigation to product and Studio routes resolves to the same application shell while real static assets are served normally.
