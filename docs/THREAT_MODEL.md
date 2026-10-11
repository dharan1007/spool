# Threat model

## Assets

User datasets, inferred schemas, transformation mappings, checkpoints, output rows, and agent-visible tool results.

## Trust boundaries

1. User-provided CSV/XLSX is untrusted input. XLSX ZIP/XML content is parsed locally and formulas are never evaluated.
2. WebMCP tool arguments are untrusted structured input.
3. Worker messages cross an asynchronous component boundary.
4. IndexedDB is durable client state and may survive an interrupted tab.
5. CSV exports may be opened by spreadsheet software with formula execution behavior.

## Controls

- No `eval`, `Function` constructor, arbitrary transform scripts, dynamic code download or remote model execution.
- Transform operator allowlist, recursion-depth cap, conservative regex rejection and bounded regex length.
- CSV/XLSX limits for cells, rows and columns; unique/non-empty headers; prototype-sensitive header names rejected. XLSX additionally rejects encrypted, ZIP64, path-traversing, unsupported-compression, integrity-mismatched, and over-expanded archives. ZIP decompression checks actual emitted bytes incrementally against declared and aggregate limits, and rejects duplicate or local/central-mismatched entry names. XLSX sparse row coordinates do not allocate implicit rows, out-of-order/duplicate row and cell references fail closed, and Excel 1900 date serial 60 is rejected rather than assigned a fictitious date.
- Target schemas are enforced on every valid output row.
- CSV cells beginning with `=`, `+`, `-`, or `@` are prefixed before export to neutralize formula interpretation.
- Worker messages require matching job/revision and strictly increasing sequence numbers.
- Runtime callbacks are serialized before checkpoint/complete state mutations.
- A terminated tab never implies Worker survival. Manual runs recover to `PAUSED_RECOVERED`; an Autopilot mission validates persisted state, creates a new Worker and resumes from the durable checkpoint.
- Agent row access is bounded; workspace inspection does not dump datasets.
- Production CSP blocks network connections (`connect-src 'none'`) and third-party assets. Application startup uses ordinary same-origin ES modules rather than compressed payload reconstruction or dynamic blob application imports.
- Bounded violation samples prevent error-volume context flooding.

> Scope note (2026-10-11): these hardening changes are on a review branch and are **not** automatically release-qualified. The 50 MiB compressed-input and 256 MiB expanded-workbook ceilings are parsing boundaries, not a promise of low peak browser RAM. Independent browser memory and malformed-workbook execution gates remain mandatory before public promotion.

## Residual risks

- Browser storage quota varies by device and browser.
- Very large CSVs remain memory-sensitive because the current parser accepts an in-memory text source after a 50 MB UI file gate.
- Conservative regex screening reduces but cannot mathematically prove absence of every pathological regular expression.
- Native WebMCP availability depends on browser implementation status.
