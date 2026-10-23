# Workspace model

A workspace is a folder on disk plus a metadata record. It contains your
migrations, drafts and recipes for one context of work (e.g. "CRM imports Q4").

## Storage split (authoritative vs presentation)

| Store | Location | Authority |
| --- | --- | --- |
| Engine run state (`state.db`) | `<workspace>/migrations/<id>/state.db` | **the only** source of truth for run outcomes, durable state transitions, checkpoints, leases, receipts |
| Console metadata (`console-meta.db`) | `%APPDATA%\SPOOL Console` | workspaces, drafts, recipes, preferences, activity log, **cache** of last status |

The Console never treats `lastStatus` in its metadata as proof: every status
display re-reads the engine (`migration.status`) when a service is loaded.
Recovery views read the engine's durable state machine (`restartDecision`,
`transitions`), so a crash leaves both views consistent with the disk.

## Lifecycle

- **Create** — a named folder; no files are moved or copied into it except
  project metadata. Your CSV and SQLite files stay where they are; the engine
  reads them in place through its strict path policy
  (`sourceRoot`/`targetRoot` are their own directories).
- **Archive** — hides it from the active list; blocks renaming and new
  migrations until restored. Archived workspaces never delete data.
- **Impact report** (`workspace.impact`) — counts migrations and RUNNING/QUEUED
  work before archive/delete flows; the note text is explicit that customer
  CSV/SQLite files are never removed by Console flows.

## Migration directories

```
<workspace>/migrations/<migrationId>/
  state.db            engine durable state
  snapshots/          byte-bound source snapshots (cleaned after success)
  source-profile.json exact inspection record incl. sha256 fingerprint
  evidence/           exported bundles (on demand)
```

`migrationId` is a fresh UUID per record; engine `MIGRATION_ID_REUSE_CONFLICT`
protection therefore has no practical role for the Console, but correct
semantics are retained: a completed migration id is never re-run with changed
semantics.
