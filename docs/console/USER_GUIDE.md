# SPOOL Console user guide

## First launch

The Console creates its data under `%APPDATA%\SPOOL Console`:

- `console-meta.db` — your workspaces, drafts, recipes, preferences,
  migration index (presentation cache only; migration truth lives in each
  migration's `state.db`)
- `approval-key.bin` + `approval-key.json` — your approval signing key,
  encrypted with Windows DPAPI through safeStorage. These files only exist on
  this machine; copying them elsewhere fails closed by design.

## The five steps

1. **Source** — `Choose CSV…` opens the native file dialog. The file must be
   UTF-8 CSV (256 MiB ceiling). Inspection shows exact row count (streamed),
   inferred column types, nullability, sample distinct counts and a content
   fingerprint. Ambiguous-looking dates/numbers raise warnings to review — the
   engine still decides deterministically; nothing is guessed at run time.
2. **Destination** — `Choose SQLite database…` puts you on an *existing*
   database. The Console lists ordinary tables, marking triggered/virtual
   tables as ineligible (side effects outside the approved plan are refused
   rather than worked around).
3. **Mapping** — map every target column you intend to fill. Each mapping
   entry is compiled by the engine's allow-listed operators
   (`field`, `trim`, `cast_number`, `cast_enum`-style `enum_map`,
   `parse_date`, …). Free SQL or generated code is impossible by design.
   Unmapped required columns block the review step.
4. **Review** — a bound plan id and a dry-run summary are shown: rows
   processed, valid, rejected and violation codes. Nothing has been written
   yet. Generating a new plan invalidates the previous dry-run.
5. **Execute** — approving signs the exact plan + snapshot + target contract
   (and expiry). Execution streams through the engine with per-batch ledger,
   fencing and checkpoints; the result page comes from the engine receipt:
   status, written/rejected rows, verification result.

## Where things land

- Migration state + snapshots: inside the workspace directory you chose, under
  `migrations/<migrationId>/`.
- Evidence bundles: exported to a directory you select; each includes a sha256
  manifest. Verification of a modified bundle fails loudly.
- History: migrations with live status from the engine state machine.

## Errors you may encounter

Every error is a stable code with next actions. The most common:

- `SOURCE_UNCHANGED_CHECK_FAILED` — the CSV changed since inspection; re-inspect.
- `MAPPING_INCOMPLETE` — required columns unmapped or duplicated.
- `MIGRATION_STEP_OUT_OF_ORDER` — dry-run/approve on a stale plan; regenerate.
- `APPROVAL_EXPIRED` — approve again; approvals are bounded in time.
- `APPROVAL_KEY_UNAVAILABLE` — signing key could not be opened safely on this
  profile; see WALL first in WINDOWS_FIRST.md.

There is no hidden re-try of destructive-looking operations; if a surface says
"unavailable", it is unavailable on this release.
