# Troubleshooting

## Boot problems

| Symptom | Cause | Remedy |
| --- | --- | --- |
| Window never appears, stderr `RELEASE_BUNDLE_UNVERIFIED` | engine manifest missing/malformed in the installed location | reinstall the app package; never hand-edit `engine/manifest.json` |
| stderr `APPROVAL_KEY_UNAVAILABLE` at boot | safeStorage unavailable, or stored key cannot be decrypted on this Windows profile | verify you run under the same Windows user profile that created the key; deleting `%APPDATA%\SPOOL Console\approval-key.bin` + `.json` regenerates the key (old approvals stay unusable by design) |
| `better-sqlite3` ABI error at boot | native module rebuilt for a different Electron/Node ABI | use the shipped package (ABI-matched) or run `npx electron-rebuild -f -w better-sqlite3 -v <electron version>` inside `apps/console` |

## Wizard problems

| Error code | Meaning | Fix |
| --- | --- | --- |
| `SOURCE_TOO_LARGE` | CSV exceeds the 256 MiB qualified ceiling | split the file or extend the ceiling consciously per the engine release policy |
| `SOURCE_UNCHANGED_CHECK_FAILED` | CSV changed after inspection | re-inspect and replay the journey |
| `UNKNOWN_SOURCE` (mapping) | mapped source column does not exist in the current profile | re-inspect or fix the mapping |
| `MAPPING_INCOMPLETE` | required columns unmapped/duplicated | complete the mapping in step 3 |
| `TARGET_*` (preflight) | live target deviates from declared schema (missing columns, triggers, generated columns) | align the table with your design; preflight protects you from writing into a schema you did not intend |
| `MIGRATION_STEP_OUT_OF_ORDER` | plan/dry-run/approval got stale | regenerate plan, dry-run again, then approve |
| `APPROVAL_EXPIRED` | validity window passed | approve again |
| `MIGRATION_ALREADY_RUNNING` | execute while a run is active | wait for the run to finish or abort explicitly |
| `APPROVAL_KEY_UNAVAILABLE` at execute | key could not be opened | see boot-problems row above |
| `CONSOLE_VALIDATION_FAILED` | request shape not in the contract | reload the step; if persistent, file an issue with a diagnostics export |

## Data-location facts that help support

- Engine state: `<workspace>\migrations\<migrationId>\state.db`
- Console metadata: `%APPDATA%\SPOOL Console\console-meta.db`
- Evidence/support exports: wherever you selected
- No cloud copy exists; nothing is uploaded anywhere by design

## Reproducing issues maps

1. `npm test` inside `apps/console` re-runs the engine-coupled suites.
2. `node_modules\electron\dist\electron.exe scripts\harness.js` (inside
   `apps/console`) re-runs the full IPC journey and prints one JSON result.
3. `diagnostics.export` from the running app captures environment + activity.
