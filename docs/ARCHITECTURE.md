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

## PostgreSQL CDC cutover

The no-gap argument is ordering, not a shared snapshot: `establish-cdc-boundary` reserves source WAL at point P before approval, approval materializes the full-load snapshot S after P, `run` commits S before any CDC apply, and `catch-up-cdc` / the `FINAL_DRAIN` apply the stream `[P, ...]` strictly after the load through idempotent PK upserts/deletes. Streaming while the full load is in flight is refused, and snapshot repair after CDC advanced is refused (`REPAIR_CDC_CONFLICT`).

Cutover requires a quiesced source (no commits from `commit-cutover` preparation through verification): racing writes fail the fresh live-source proofs closed rather than slipping into the commit. The `FINAL_PRE_CUTOVER`/`POST_CUTOVER` proofs replay the live source, require exact content equality plus target row-count equality (key-point reads cannot see extras), and require a coherent ledger (same plan, mapping revision and boundary snapshot; `load`/`cdc` kinds only). `release-cdc-boundary` drops only migration-owned slots; pre-existing slots are never dropped.

One source transaction is exactly one target commit: `PostgresTarget.commitCdcTransaction()` validates the fence and target contract, reconciles the transaction identity against the ledger (replay returns the original exact counts), applies ordered mutations inside a single transaction (consecutive upserts set-batched, deletes applied in source order with precondition checks, one `cdc` ledger record), and commits once. Oversized source transactions spill to durable staging during assembly and stream back through `iterateTransactionEvents()` — peak memory scales with chunk size, never transaction size — with an incremental ordered-payload hash binding the stream. `src/cutover/write-barrier.js` defines the source write-barrier protocol. The former `DATABASE_READ_ONLY` mechanism is disabled because PostgreSQL database defaults do not fence pre-existing sessions. The implemented database fence is `POSTGRES_TABLE_SHARE_LOCK`: a dedicated transaction holds `SHARE` on the migrated table, waits for active DML to drain, blocks new `ROW EXCLUSIVE` DML while allowing `SELECT` verification, independently proves the conflicting lock is rejected, captures the final LSN while fenced, and is re-verified before the irreversible cutover decision. PostgreSQL cutover additionally requires an `EXTERNAL_OPERATOR_BARRIER` attestation with a concrete routing/freeze decision, and makes no zero-downtime claim; application-gate/proxy-router automation remains unsupported.

Qualification (`scripts/qualify/industrial-postgres.js`, manifest schema v3) runs ten required scenarios with no silent workload caps: every scenario records requested and effective configuration, the harness fails `PROFILE_DOWNSCALED` on any divergence, CLI/env overrides rename the run `<BASE>_CUSTOM`, and the independent verifier (`verify-evidence.js`) rejects immutable-name divergence. `postgres.cdc.productionLifecycle` drives the customer path (`establishCdcBoundary`/`approve`/`run`/`catchUpCdc`/`beginCutover`/`commitCutover`/`releaseCdcBoundary`) with deterministic writers, declared-size large transactions, and exact source/target convergence proofs.

## Release delivery

Production is delivered as ordinary same-origin static assets: `index.html`, `styles.css`, ES modules under `/src`, and the module Worker. The release deliberately does **not** reconstruct the application from compressed JavaScript payload chunks, `DecompressionStream`, or a dynamic blob module import. This removes an unnecessary startup failure boundary and keeps browser execution debuggable.

Vercel uses one SPA rewrite from `/(.*)` to `/index.html`, so direct navigation to product and Studio routes resolves to the same application shell while real static assets are served normally.
