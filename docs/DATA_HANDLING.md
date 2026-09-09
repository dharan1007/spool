# SPOOL Data Handling

This document describes the implemented data-handling boundaries of the current SPOOL release. It is a technical operating statement, not a substitute for a customer-specific data-processing agreement.

## Browser Studio

The hosted Studio is a static application. CSV parsing, profiling, deterministic transformation, Worker execution, IndexedDB persistence, quality analysis and export happen in the user's browser. The production Content Security Policy includes `connect-src 'none'`, and SPOOL application code has no dataset upload API, analytics endpoint, hosted model call, WebSocket or beacon path.

The browser Studio currently rejects CSV input above 50 MiB before migration ingestion. IndexedDB capacity is preflighted when the browser exposes storage estimates, and persistence failure is fail-closed: an in-memory run is not allowed to remain presented as durable `COMPLETE` when terminal state cannot be stored.

Static hosting and normal web infrastructure may process ordinary HTTP request metadata needed to deliver application assets (for example IP-derived network metadata, user agent and requested path according to the hosting provider's operation). That is separate from SPOOL's dataset data plane; raw CSV rows are not sent by SPOOL application code.

## Local runner / CLI / spoold

The Gate-B production runner currently supports filesystem UTF-8 CSV input to an existing SQLite target table. The default source boundary is 256 MiB and is enforced before execution. The runner reads source bytes through the same open file descriptor used to establish the source content fingerprint, preventing a resume from silently binding to different bytes.

Current SQLite execution is local. The connector does not accept a password, token or remote endpoint. Paths are resolved against configured source/target allow-roots and realpath containment; traversal and symlink/junction escape attempts are rejected.

`spoold` binds to loopback only, requires bearer authentication and validates Host/Origin boundaries. It is a local transport over the same command service used by the CLI; it is not a hosted dataset API.

## Migration evidence stored locally

A production SQLite migration may create or persist:

- a source snapshot identity and content hash;
- the semantic migration plan identity;
- live target-contract fingerprint;
- local run/checkpoint state;
- a per-batch reconciliation ledger in the SQLite target;
- row counts and grouped violation counts;
- verification results;
- a canonical migration receipt and receipt hash.

These records intentionally identify migration semantics and outcomes. They do not intentionally store resolved credentials. Violation evidence exposed through normal agent/product surfaces is bounded; customers should not assume arbitrary error text is safe to publish without review.

## Support and commercial assessment

The public GitHub Migration Assessment issue is for non-sensitive scoping metadata only. Never submit source files, row samples, database dumps, credentials, personal information, confidential URLs or customer/employee/financial records in a public issue.

If a commercial engagement requires access to sensitive data, the parties must establish a private contact channel and written scope before the data is exchanged. Prefer running SPOOL inside the customer's environment and sharing schema/violation/receipt metadata rather than raw rows whenever that is sufficient.

## Data retention

The hosted browser product does not maintain a SPOOL server-side dataset store. Browser-local IndexedDB remains under the user's browser profile until cleared by the user/browser or overwritten by product workflow. Local-runner state and SQLite ledger evidence remain in the customer-selected filesystem/target until the customer removes them according to its own retention policy.

Any customer-specific retention, deletion, subprocessors, geographic processing or incident obligations must be defined in the applicable commercial agreement; this repository document does not invent those terms.

## Security reporting

Do not put exploit payloads or sensitive reproduction data into public issues. Follow `SECURITY.md` and request a private channel when required.
