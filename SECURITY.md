# Security policy

SPOOL processes untrusted CSV content inside the browser, so parser, transform, worker, storage and export bugs are treated as security-relevant even though the application has no server-side dataset API.

## Report a vulnerability

Do not publish an exploitable payload in a public issue. Report the affected version, reproduction steps, expected impact and a minimal non-sensitive fixture to the repository owner through GitHub's private vulnerability reporting flow when enabled. If that flow is unavailable, open a public issue that contains only a high-level description and request a private contact channel before sharing exploit details.

## Security properties expected in every release

- `connect-src 'none'` remains in the production CSP; source data is not transmitted by application code.
- `eval`, `Function`, dynamic code download and arbitrary user scripts are prohibited.
- Transform expressions are limited to the checked IR operator allowlist and recursion/regex bounds.
- Worker messages are scoped to job ID, mapping revision and monotonic sequence number.
- Loading a replacement source aborts an existing runtime before resetting the workspace.
- CSV export neutralizes spreadsheet formulas beginning with `=`, `+`, `-`, or `@`.
- Agent-facing row access is bounded and source/result content is considered untrusted.

Run `npm run check` before reporting a release candidate. See `docs/THREAT_MODEL.md` for the detailed trust boundaries and residual risks.
