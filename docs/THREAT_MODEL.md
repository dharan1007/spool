# Threat model

## Assets

User datasets, inferred schemas, transformation mappings, checkpoints, output rows, and agent-visible tool results.

Enterprise registry state is also an asset: organizations, workspaces and their directory bindings, principal memberships and roles, issued API key identifiers and hashes, migration records and the append-only activity journal.

## Trust boundaries

1. User-provided CSV/XLSX is untrusted input. XLSX ZIP/XML content is parsed locally and formulas are never evaluated.
2. WebMCP tool arguments are untrusted structured input.
3. Worker messages cross an asynchronous component boundary.
4. IndexedDB is durable client state and may survive an interrupted tab.
5. CSV exports may be opened by spreadsheet software with formula execution behavior.
6. The enterprise daemon (`spoold-v2`) is an HTTP boundary reached over loopback. Callers present either the platform root bearer token or a workspace-pinned API key, and every route is authorized independently of the caller's claims.
7. Workspace directories, the registry SQLite file and the migration target databases are durable local state that a process crash or a hostile local actor can reach directly.
8. The scheduler and native qualification runs share a database lease table; a second process can legitimately observe and compete for the same lease.

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

### Enterprise daemon surface (2026-10-27)

- Credentials: API keys are generated with a random secret, returned once, and persisted only as a SHA-256 hash (`src/platform/api-keys.js`); the platform root bearer token must be at least 32 bytes and is compared in constant time (`safeTokenEqual`).
- Authorization is deny-by-default per route (`authorizeRole` over `admin|operator|viewer`) and per record. An API-key principal is pinned to the workspace it was issued for; presenting any other workspace fails closed with `WORKSPACE_NOT_FOUND`, and a migration that is not visible to the principal fails with `MIGRATION_NOT_FOUND` (404) so record existence does not leak across tenants.
- Key issuance and membership administration are single SQLite transactions: issuing a key also provisions the principal's membership and appends `API_KEY_ISSUED`; revocation records `API_KEY_REVOKED`. Workspace membership mutations and role changes are audit-logged with actor, workspace and detail.
- Per-principal sliding-window rate limiting rejects excess requests with `RATE_LIMIT_EXCEEDED` (429) before any registry or engine work happens.
- The scheduler no longer exposes a schedule-interval mode that approves or executes without an operator decision; it stages only, and a scheduled stage must still hold a durable, expiring lease. Lease takeover requires a strictly newer fencing token, and a stale runner is refused by the target database, not by cooperative in-process flags.
- Native fault injection (`disposableExecutionHook`) refuses to run unless the fixture root carries the disposable-qualification marker and the service reports `DISPOSABLE_QUALIFICATION`, so crash/lease tests cannot be pointed at real data.

> Scope note (2026-10-11): these hardening changes are on a review branch and are **not** automatically release-qualified. The 50 MiB compressed-input and 256 MiB expanded-workbook ceilings are parsing boundaries, not a promise of low peak browser RAM. Independent browser memory and malformed-workbook execution gates remain mandatory before public promotion.

## Residual risks

- Browser storage quota varies by device and browser.
- Very large CSVs remain memory-sensitive because the current parser accepts an in-memory text source after a 50 MB UI file gate.
- Conservative regex screening reduces but cannot mathematically prove absence of every pathological regular expression.
- Native WebMCP availability depends on browser implementation status.
- Rate-limit windows live in daemon process memory, so limits are per process, not global across replicas; a restarted daemon starts with empty windows. Bounding this requires a shared counter store and is not claimed today.
- The daemon speaks plain HTTP and relies on loopback binding plus an external TLS terminator; the bearer token is only as safe as that network boundary.
- Issued API keys have no TTL and no rotation-required state; revocation is explicit and immediate, but a leaked key stays valid until revoked.
- The activity journal is append-only by convention in SQLite, not by an external WORM store, and a local actor with filesystem access could alter it.
- Enterprise registry isolation is enforced by the daemon and proven by tests; it is not an independent audit finding (see BLOCKERS B004).
- Two high `npm audit` findings remain in the **optional-driver** dependency graph: GHSA-xcx6-jx8p-x3h5 in `@azure/msal-node` 5.6.0, pulled in by `@azure/identity` through `mssql`/`snowflake-sdk`. The core production closure (`npm audit --omit=dev`) reports 0 findings because those drivers are not installed by the core artifact, and SQL Server/Snowflake stay outside the production allowlist. No compatible upgrade exists (the parent pins `^6.0.0`, which is inside the affected range) and SPOOL never invokes the affected authorization-code flow; see `docs/DEPENDENCY_RISK.md` for the reachability analysis, the per-artifact audit and the remediation trigger.

### Cloud HTTP transport (Snowflake / BigQuery wire endpoints)

- The endpoint is plan-supplied data, so it is treated as untrusted: http(s) only, no
  embedded credentials, no fragment, control characters or over-long URLs.
- Cloud metadata services (`169.254.169.254`, `metadata.google.internal`,
  `metadata.goog`, `100.100.100.200`, `fd00:ec2::254`, `instance-data`) and
  link-local, unspecified, multicast and reserved addresses are refused always,
  including decimal/octal/hex and IPv4-mapped IPv6 spellings. No configuration
  enables them.
- Loopback and private targets (RFC1918, CGNAT, IPv6 ULA, `localhost`) are refused by
  default. The target ref cannot grant itself access; an operator must name the
  endpoint with `SPOOL_CLOUD_PRIVATE_ENDPOINT_HOSTS`. `SPOOL_CLOUD_PRIVATE_ENDPOINT_HOSTS`
  and `SPOOL_CLOUD_REQUIRE_TLS` are documented in `docs/SELF_HOSTING.md`.
- Hostnames are resolved through a guarded DNS lookup that validates **every**
  resolved address and returns the validated address for the connection, so a
  name resolving to a forbidden address, or re-bound between validation and
  connect, is refused.
- Redirects are never followed; a `3xx` is returned and treated as a failed
  response, so a redirect cannot re-target the request. Request and response
  bodies have byte ceilings, and an idle timeout plus a total deadline bound
  stalled or trickling transfers.
- **Not claimed:** this is bounded SSRF resistance for a local-first product that
  must reach local endpoints, not complete SSRF protection. It does not stop a
  public hostname whose DNS answer changes after the connection is established,
  it does not police proxy settings, and an operator who allowlists a private host
  has chosen to trust it.
