# Dependency risk register

Every release candidate runs

```
npm audit --omit=dev --audit-level=high --json
```

as a mandatory gate in `scripts/qualify-bounded-release.js` (`security_audit`).
A high or critical finding in a production dependency blocks the candidate.
This file records findings that cannot be resolved by a compatible upgrade,
with the reachability analysis behind the decision. The gate itself is never
lowered to make a candidate pass; a recorded finding keeps the release
`BLOCKED` until the remediation trigger fires.

## DR-001 — GHSA-xcx6-jx8p-x3h5 in `@azure/msal-node`

Status: OPEN — blocks release qualification (requesting the audit gate to pass
would be masking, not fixing).

| Field | Value |
| --- | --- |
| Advisory | GHSA-xcx6-jx8p-x3h5 — "MSAL Node authorization code flow may disclose parameters to an attacker-controlled endpoint" |
| Severity | High, CVSS 3.1 base 7.5 (`AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N`), CWE-346 |
| Affected range | `@azure/msal-node` >= 5.0.0-beta.0 < 7.1.0 |
| Installed | `@azure/msal-node@5.6.0` |
| Fixed in | `@azure/msal-node@7.1.0` (7.1.1 published) |
| Dependency paths | `mssql@12.7.2 -> tedious@20.0.0 -> @azure/identity@4.13.2 -> @azure/msal-node@5.6.0`; `snowflake-sdk@3.4.0 -> @azure/identity@4.13.2` (deduped) |
| Audit metadata | production dependencies 282, high 2 (both entries are the same MSAL issue), critical 0 |

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
supply-chain risk, not a remediation, so it is not applied and the audit gate
stays failing.

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
- Exposure for the shipped product is therefore limited to loading the module,
  not executing the vulnerable flow. The residual risk is a future change that
  adds Azure AD authentication without revisiting this record.

### Remediation trigger

Re-run the gate as soon as any of the following is true:

1. `@azure/identity` publishes a release that depends on
   `@azure/msal-node >= 7.1.0` — bump `mssql`/`snowflake-sdk` or add a direct
   dependency and re-run `npm audit --omit=dev --audit-level=high` plus
   `npm test`;
2. `tedious` or `snowflake-sdk` drop `@azure/identity`, or a newer major stops
   pulling MSAL;
3. the connectors move Azure AD authentication into an optional, separately
   installed adapter.

Also revisit the decision if SPOOL ever invokes an MSAL authorization-code
flow, at which point the finding becomes directly exploitable and the
affected connectors must not ship.
