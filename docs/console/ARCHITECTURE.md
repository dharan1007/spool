# SPOOL Console architecture

## Process model

```
+-------------------------------------------+
| Renderer (sandboxed, no node integration) |
| React wizard, calls window.spool.invoke() |
+--------------------+----------------------+
                     | validated operation + payload (ipcRenderer.invoke)
+--------------------v----------------------+
| Electron main process                     |
|  guard: contracts.validateRequest()       |
|  dispatch: ipc-router.js                  |
|  service: console-service.js              |
|    - workspace-store (console metadata)   |
|    - source discovery (engine CSV code)   |
|    - sqlite catalog (read-only)           |
|    - recipes, settings, diagnostics       |
|  approval key: safeStorage (DPAPI)        |
+--------------------+----------------------+
                     | in-process import (privileged)
+--------------------v----------------------+
| Engine bundle: SpoolCommandService        |
| state.db + snapshots/ per migration       |
| durable state machine, leases, receipts   |
+-------------------------------------------+
```

Trust orientation: authority flows downward only. The renderer holds no
authority (no key, no engine, no filesystem access, no network). The main
process is the only privileged context and validates every operation against
`service/contracts.js` before dispatch. The engine remains the sole authority
over migration outcomes; the Console workspace store caches presentation state
only.

## Migration isolation

Every migration gets its own directory under the workspace root:

```
<workspace>/migrations/<migrationId>/
  state.db          engine RunStore (durable state machine)
  snapshots/        durable source snapshots
  source-profile.json  exact inspected profile (fingerprint bound)
  evidence/         exported bundles (optional)
```

`SpoolCommandService.create()` is instantiated lazily per migration with
`sourceRoot = dirname(csv)` and `targetRoot = dirname(sqlite)`, giving strong
path containment: the engine resolve policy rejects any path outside the
source or target directory, including symlinks and `..`.

## Wire contract

All privilege-carrying operations are declared once in
`apps/console/service/contracts.js` (zod, `.strict()`). The renderer may not
reach an undeclared operation and may not smuggle additional fields; both
denials return `CONSOLE_VALIDATION_FAILED`. Contract version is 1;
incompatible future shapes must bump it.

## Engine sync and release binding

`scripts/console/sync-engine.mjs` copies `src/`, `capabilities/` and
`package.json` verbatim into `apps/console/engine/` and writes
`manifest.json` containing:

- `engineVersion` (must equal `1.1.2`, matching the pinned production policy)
- `engineCommitSha` (40-hex git commit the bundle was created from)
- `aggregateSha256` over every copied file
- `capabilityAggregateSha256` over the capability matrix

At startup the main process reads the manifest, refuses to boot when the SHA
is missing or malformed, and `system.verifyRelease` re-derives the equality
programmatically so the renderer can display a verified release identity.

## Data flow of a migration

1. **Inspect** — engine streaming parser + schema inference only
   (`inspectCsvStream`, `inferSchema`); a sha256 fingerprint is recorded.
2. **Create** — the wizard design is preflighted against the live target
   (`inspectSqliteTarget`), then stored; the source profile is frozen into
   `source-profile.json`.
3. **Plan** — `buildPlanInput` maps the wizard intent onto the engine's
   canonical plan input (plan identity `spool-plan-v1`); `service.plan()`
   recomputes the plan through the engine and asserts the source is unchanged.
4. **Dry-run** — engine accumulator summary; plan id must match the stored
   plan, otherwise `MIGRATION_STEP_OUT_OF_ORDER`.
5. **Approve** — assertion that source, plan and dry-run are bound to the same
   plan id; the engine creates a bound approval (key from safeStorage key
   store). Expiry defaults from settings (`approvalMinutes`).
6. **Execute** — `migration.execute` re-checks the source hash, the approval
   and the duplicate-run guard; `service.run()` streams, checkpoints, fences
   and verifies through the engine; receipt + verification come from the
   engine.
7. **Evidence** — the Console bundles the stored plan/dry-run/approval plus a
   sha256 manifest; `evidence.verify` re-verifies and fails closed on drift.

## Failure containment

- Engine errors surface with their stable codes through `toEnvelope`; the
  Console never emits raw stack traces to the renderer.
- `CONSOLE_INTERNAL_ERROR` is the catch-all for unexpected failures; details
  are sanitized (keys matching /password|secret|token|key|credential/i are
  redacted, strings are length-bounded).
- The workspace media store and the engine state database are separate files;
  corruption in one never upgrades into silent compromise of the other.
