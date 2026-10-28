# Dependency risk register

Every release candidate runs

```
npm audit --omit=dev --audit-level=high --json
```

as a mandatory gate in `scripts/qualify-bounded-release.js` (`security_audit`).
A high or critical finding in a production dependency blocks the candidate.

The gate applies to the **core production dependency set**: `dependencies` in
`package.json`, which is exactly what `npm ci --omit=dev`, the release tarball
and the daemon image install. Optional connector drivers are split out of that
set by design (DR-002) and are audited separately; they are not silently
excluded, and the connectors that need them stay outside the production
allowlist.

This file records findings that cannot be resolved by a compatible upgrade,
with the reachability analysis behind the decision. The gate itself is never
lowered to make a candidate pass; a recorded finding keeps the affected scope
`BLOCKED` until the remediation trigger fires.

## DR-001 — GHSA-xcx6-jx8p-x3h5 in `@azure/msal-node`

Status: OPEN upstream; scoped out of the core production install by DR-002.
Any install that adds `mssql` or `snowflake-sdk` is still affected, and both
connectors remain non-production-qualified.

| Field | Value |
| --- | --- |
| Advisory | GHSA-xcx6-jx8p-x3h5 — "MSAL Node authorization code flow may disclose parameters to an attacker-controlled endpoint" |
| Severity | High, CVSS 3.1 base 7.5 (`AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N`), CWE-346 |
| Affected range | `@azure/msal-node` >= 5.0.0-beta.0 < 7.1.0 |
| Installed (optional scope) | `@azure/msal-node@5.6.0` |
| Fixed in | `@azure/msal-node@7.1.0` (7.1.1 published) |
| Dependency paths | `mssql@12.7.2 -> tedious@20.0.0 -> @azure/identity@4.13.2 -> @azure/msal-node@5.6.0`; `snowflake-sdk@3.4.0 -> @azure/identity@4.13.2` (deduped) |
| Audit metadata | full tree (dev included) 2 high, both the same MSAL issue; core production tree 0 findings (DR-002) |

### Why no compatible upgrade exists

`@azure/identity` pins the vulnerable major: 4.13.2 declares
`"@azure/msal-node": "^5.1.5"` (the lockfile installs 5.6.0) and 4.14.0, the
current latest, declares `^6.0.0`. Every 5.x and 6.x release is inside the
affected range, and no published `@azure/identity` version (stable or
prerelease, checked against the registry) declares `^7.1.0` or newer, so no
version of the parent can pull a fixed `@azure/msal-node`.
`npm audit fix --dry-run` reports that it changed packages and still reports
the same two high findings, because it cannot leave the parent's declared
range.

Re-checked 2026-10-28: `@azure/identity` latest is still `4.14.0` (`^6.0.0`),
the `beta` dist-tag is `4.15.0-beta.1` and also declares `^6.0.0`,
`@azure/msal-node` latest is `7.1.2`, `mssql` latest is `12.7.13` with
`tedious 20.3.8` (still `@azure/identity ^4.13.1`), and `snowflake-sdk` latest
is `3.4.1` (still `@azure/identity`). No parent release can reach a fixed
MSAL, so DR-001 stays OPEN upstream.

### The `overrides` alternative was tested and is not safe

Forcing `@azure/msal-node@7.1.1` under a parent that declares `^5.1.5`/`^6.0.0`
was evaluated in an isolated install of the exact production dependency set
(`npm install --omit=dev` with `overrides: { "@azure/msal-node": "7.1.1" }`):

- Install and module load succeed: `require('@azure/identity')`,
  `require('mssql')` and `require('snowflake-sdk')` all resolve, and
  `ClientSecretCredential`, `UsernamePasswordCredential` and
  `AuthorizationCodeCredential` construct without throwing.
- The API surface is not compatible: in 7.1.1
  `ConfidentialClientApplication` no longer exposes `acquireTokenSilent`
  (only `getAuthCodeUrl`, `acquireTokenByCode`, `acquireTokenByClientCredential`,
  `acquireTokenOnBehalfOf`, `acquireTokenByUserFederatedIdentityCredential`),
  while `@azure/identity@4.13.2` calls `acquireTokenSilent` in its shared
  MSAL client (`dist/commonjs/msal/nodeFlows/msalClient.js:155`). The silent
  token path used by every cached/refresh flow would fail at runtime with a
  `TypeError`, which no test in this repository can catch because SPOOL never
  performs Azure AD token acquisition.

A major-version override that breaks a code path we cannot exercise is a
supply-chain risk, not a remediation, so it is not applied.

### Reachability analysis

- The advisory covers the MSAL **authorization-code** flow. SPOOL has no code
  path that performs interactive, browser or device-code Azure authentication:
  `src/` contains zero references to `InteractiveBrowserCredential`,
  `AuthorizationCodeCredential`, `DeviceCodeCredential`, `DefaultAzureCredential`
  or `@azure/identity`.
- `mssql` connects through tedious SQL authentication
  (`src/connectors/mssql/runtime.js`); `require('mssql')` does not even load
  `@azure/msal-node` (verified by inspecting `require.cache` after import).
- `snowflake-sdk` does load `@azure/msal-node` eagerly
  (`lib/authentication/auth_workload_identity/attestation_azure.js`), but
  SPOOL builds its connection without any authenticator or OAuth credential
  (`src/connectors/snowflake/connection.js`: account, username, database,
  schema, warehouse, role), so the MSAL flow is loaded but never invoked.
- Exposure for any install that includes the optional driver is therefore
  limited to loading the module, not executing the vulnerable flow. The core
  release does not install it at all.

`tests/connector-auth-surface.test.js` pins this so it cannot drift: the SQL
Server config is asserted to carry SQL credentials only (an
`authentication=azure-active-directory` endpoint query is rejected), the
Snowflake driver options are rebuilt from an explicit key list so an injected
`authenticator`/token/password/clientId can never reach the driver, and no file
under `src/connectors` may reference an Azure credential class.

### Remediation trigger

Re-run the gate as soon as any of the following is true:

1. `@azure/identity` publishes a release that depends on
   `@azure/msal-node >= 7.1.0` — bump the optional driver and re-run
   `npm audit --omit=dev --audit-level=high` plus the connector conformance
   suites;
2. `tedious` or `snowflake-sdk` drop `@azure/identity`, or a newer major stops
   pulling MSAL;
3. the connectors move Azure AD authentication into an optional, separately
   installed adapter.

Also revisit the decision if SPOOL ever invokes an MSAL authorization-code
flow, at which point the finding becomes directly exploitable and the
affected connectors must not ship.

## DR-002 — optional connector drivers are excluded from the core install

Status: APPLIED. Core production dependency set: 0 high/critical findings.
Optional connector scope: still affected by DR-001, connectors unqualified.

### Scope is per artifact, not global

B007 must not be called resolved for every artifact. There are two distinct
distributions and they are audited separately:

| Artifact | Install set | Audit command | Status |
| --- | --- | --- | --- |
| core (`spool-webmcp` tarball, daemon image) | `dependencies` only | `npm audit --omit=dev --audit-level=high` | **PASS** — 0 findings |
| optional connector drivers | core + `devDependencies` (`mssql`, `snowflake-sdk`) | `npm audit --audit-level=high` | **OPTIONAL_SCOPE_AFFECTED** — GHSA-xcx6-jx8p-x3h5, connectors not production-qualified |

`scripts/audit-artifacts.js` runs both audits and emits one JSON report per
artifact (`status`, `highs`, `criticals`, `advisories`, `productionAllowlist`,
`affectedConnectors`). It exits 1 only when the core artifact has a
high/critical finding; an affected optional scope is recorded as
`OPTIONAL_SCOPE_AFFECTED`, never as a pass.

The dependency scope and the capability register are tied together by
`tests/dependency-artifacts.test.js`, which fails if:

- a capability backed by an affected driver (`mssql.*`, `snowflake*`) is
  promoted to `PRODUCTION`;
- those capabilities are deleted from the matrix to make the register look
  complete;
- the optional driver closure stops resolving `@azure/msal-node`, or the
  installed MSAL version escapes the recorded affected range (that is the
  remediation trigger firing, and DR-001 must be re-evaluated).

### Decision

`mssql` and `snowflake-sdk` moved from `dependencies` to `devDependencies`.
The connector code stays in `src/connectors/{mssql,snowflake}` and ships with
the package, but the drivers load only on first use:

- `src/connectors/driver-loader.js` imports the driver dynamically, caches the
  successful load, and maps a missing package to
  `CONNECTOR_DRIVER_UNAVAILABLE`, a missing API or wrong major to
  `CONNECTOR_DRIVER_INCOMPATIBLE`, and any other load failure to
  `CONNECTOR_DRIVER_LOAD_FAILED`. The error is raised before a credential is
  read or a socket is opened.
- `src/connectors/mssql/driver.js` requires `ConnectionPool`, `Transaction`,
  `Request` and `ISOLATION_LEVEL` from `mssql` major 12.
- `src/connectors/snowflake/driver.js` requires `createConnection` from
  `snowflake-sdk` major 3.
- `scripts/static-check.js` fails the build if any file under `src/` imports
  either driver statically.

The core daemon, CLI and Browser Studio never need a remote driver: their
production allowlist is SQLite and filesystem. PostgreSQL, MySQL and BigQuery
remain production dependencies because they carry no open advisory and are the
qualified/near-qualified paths; they are loaded by the modules that use them.

### Evidence

- `npm audit --omit=dev --audit-level=high` -> `found 0 vulnerabilities`.
- `npm audit --audit-level=high` (dev included) -> still 2 high, GHSA-xcx6-jx8p-x3h5.
- `node scripts/audit-artifacts.js` -> `core: PASS`, `optional-drivers:
  AFFECTED`, overall `OPTIONAL_SCOPE_AFFECTED`, `productionAllowlist: allowed`.
- `tests/dependency-artifacts.test.js` (7 tests): production-closure walk over
  `package-lock.json` (no `mssql`, `snowflake-sdk`, `@azure/identity`,
  `@azure/msal-node`; `better-sqlite3`, `pg`, `mysql2`,
  `@google-cloud/bigquery` present), proof the optional closure still resolves the
  affected MSAL major, the capability/allowlist invariant, the affected-range
  boundaries, and the report classification (core clean vs optional affected vs
  core critical).
- `tests/connector-auth-surface.test.js` (3 tests): SQL-only SQL Server config,
  rebuilt Snowflake driver options, and no Azure credential class anywhere under
  `src/connectors`.
- `tests/connector-driver-boundary.test.js` (7 tests): static-import scan,
  module graph proof that the daemon and connector descriptors load with no
  driver resolution, the loader error paths, and a packed-tarball probe that
  asserts the shipped artifact fails with `CONNECTOR_DRIVER_UNAVAILABLE` instead
  of a module crash.
- The container image is built with `npm ci --omit=dev`; the in-container
  boundary check asserts `mssql` is absent and the connector reports
  `CONNECTOR_DRIVER_UNAVAILABLE`.

### What this does not do

It does not delete SQL Server or Snowflake support, does not change the
capability matrix, and does not qualify either connector. Installing a driver
reintroduces DR-001 in that install; `docs/SELF_HOSTING.md` documents the
derived-image path and the requirement to audit it separately. This record is
reopened if a driver returns to the core dependency set.
