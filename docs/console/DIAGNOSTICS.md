# Diagnostics

## `diagnostics.get`

Returns a live system view, safe to paste into an issue tracker:

- app version, engine release + commit sha (from the packaged manifest)
- platform / OS release / architecture, process versions
- production policy summary (byte ceiling, batch ceiling, checks)
- environment probe (better-sqlite3 loads, capability matrix verifies)
- store statistics (workspaces, migrations, drafts, recipes, activity rows)

## `diagnostics.export`

Writes a support bundle to a chosen directory:

```
<directory>/
  diagnostics.json     the snapshot above plus timed counters
  activity.log         recent activity codes with timestamps (bounded)
  README.txt           how to read the bundle
```

## Redaction

All user-provided strings pass through the same sanitizer used for error
envelopes (`errors.js`): keys that look secret-ish (`password`, `secret`,
`token`, `key`, `credential`, `authorization`) are replaced with `[REDACTED]`,
strings are length-bounded, paths under the user profile are kept because they
are needed for support but never file **contents**. SQL/data never enter
diagnostics: content inspection stays inside the engine and only counts/ids
are reported.

## Console-local retention

Diagnostics history is capped by `diagnosticsRetentionDays` (default 30) in
settings; older exported bundles on disk are the user's own files and are not
touched by the app.

## What diagnostics will NOT do

- No network upload, no crash-reporting service, no "phone home" of any kind
  (CSP forbids `connect-src` entirely).
- No automatic repair actions; diagnostics never mutate migration state.
