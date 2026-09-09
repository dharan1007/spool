# Security policy

SPOOL treats migration correctness as a security property. The browser Studio processes untrusted CSV locally; the Gate B local runner additionally performs approved filesystem CSV → SQLite mutation under explicit path, source, target, concurrency and authorization boundaries.

## Report a vulnerability

Do not publish exploit payloads, production data, credentials or private infrastructure details in a public issue. Use GitHub private vulnerability reporting when available. If private reporting is unavailable, open only a high-level public issue and request a private channel before sharing sensitive reproduction material.

## Browser Studio release properties

Every browser release is expected to preserve:

- production CSP with `connect-src 'none'`;
- no `eval`, `Function`, dynamic code download or arbitrary user scripts;
- constrained transform IR with recursion and regex bounds;
- deterministic date/number parsing with ambiguous values rejected;
- Worker messages bound to job ID, mapping revision and monotonic sequence;
- replacement-source abort semantics;
- durable IndexedDB completion semantics: failed persistence cannot remain COMPLETE;
- explicit 50 MiB source boundary and storage-capacity preflight;
- spreadsheet-formula neutralization on CSV export;
- bounded agent-facing row access.

## Gate B local-runner properties

The production CSV → SQLite path is expected to preserve all of the following:

- source bytes are hashed through the same opened file object whose bytes are migrated;
- source resume is bound to a content snapshot identity;
- source and target paths are restricted to configured allow-roots;
- path checks reject lexical traversal and symlink/junction escape after canonicalization;
- SQLite target preflight validates the existing ordinary table before approval;
- table DDL, columns, indexes and foreign keys contribute to a `targetContractId`;
- targets with triggers and unsupported virtual-table behavior are rejected;
- every SQLite mutation requires explicit `target_write` approval;
- approval is HMAC-bound to the exact plan, source snapshot, target contract, effects, write strategy, principal, expiry and nonce;
- durable leases issue monotonic fencing tokens;
- the active fence and target contract are rechecked inside the target write transaction;
- migrated rows and the SPOOL batch reconciliation ledger commit in the same SQLite transaction;
- exact replay is idempotent; conflicting batch evidence fails closed;
- commit-before-checkpoint recovery reconciles target evidence before replay;
- verification proves row accounting and exact ledger completeness before a receipt can be issued;
- receipts are canonical hashes bound to the SPOOL release commit;
- `spoold` binds only to loopback, requires a bearer token, validates Host/Origin and body size, and sanitizes unexpected internal failures instead of exposing stack traces or internal paths.

## Dependency/release gates

Production release validation includes:

```text
npm ci
npm audit --omit=dev --audit-level=high
native SQLite driver load
full test suite
SQLite conformance/fault suite
Linux + Windows + macOS SQLite matrix
build + benchmark + static checks
built-artifact Chrome smoke
CodeQL
```

The production deployment is accepted only when `/release.json` reports the exact Git commit intended for deployment and the remote browser smoke passes.

## Supported production mutation scope

Gate B currently supports only filesystem UTF-8 CSV → an existing ordinary SQLite table using `insert` mode. PostgreSQL/MySQL, destructive write strategies, trigger-bearing targets, virtual SQLite tables and hosted raw-row ingestion are outside the current production claim.

See `docs/THREAT_MODEL.md`, `docs/DATA_HANDLING.md`, `docs/RELEASE_PROCESS.md` and `README.md` for detailed boundaries and operational evidence.
