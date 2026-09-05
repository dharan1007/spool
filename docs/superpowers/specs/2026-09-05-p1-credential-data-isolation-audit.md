# P1 Credential and Data Isolation Audit

Date: 2026-09-05
Status: audit/design only; architectural implementation remains blocked until `2026-09-05-hybrid-local-bridge-platform-design.md` is explicitly approved in chat

## Purpose

Close the highest-impact security boundary before `spoold`, HTTP, MCP, CLI, browser pairing, or self-hosted surfaces are allowed to expose the local execution runtime.

This document does **not** authorize architectural code changes, new listeners, CSP changes, credential plumbing, or deployment.

## Current evidence

The P1 branch already has useful primitives:

- `ConfigStore` persists connector configuration separately from secret references and rejects several obvious secret-shaped keys in `config`.
- P1 secret references currently resolve from environment variables only.
- connection state files are created through a `0600` temporary file inside a `0700` state directory and atomically renamed;
- connector references reject several explicit secret-bearing key names;
- recursive redaction exists for common credential keys;
- the existing production browser build remains network-isolated by `connect-src 'none'`.

These are good foundations, but they are not yet a complete security boundary for a daemon that will accept commands from CLI/API/MCP/browser clients.

## High-impact findings

### 1. Secret-key deny lists are a defense-in-depth filter, not a type boundary

Current secret detection is based on a finite key-name set such as `password`, `token`, `apiKey`, and `authorization`.

That will miss semantically secret fields whose names are vendor- or protocol-specific, for example:

- `accessToken`;
- `refreshToken`;
- `clientSecret`;
- `privateKey`;
- `sessionKey`;
- `cookie`;
- `dsn` values containing embedded credentials;
- credentials embedded in URLs such as `postgres://user:password@host/db`;
- arbitrary connector configuration fields whose schema allows sensitive strings.

P1 must therefore enforce credential isolation structurally: connector configuration schemas need to identify secret-bearing fields and convert them to typed secret references before a descriptor can enter the durable control plane. Generic key redaction remains useful only as a second layer.

### 2. Resolved secrets need a deliberately tiny lifetime and ownership scope

`resolveSecretRef()` currently returns a plain JavaScript string. Once real remote connectors exist, that value can accidentally escape through closure capture, exception objects, debug logging, serialization, retries, or long-lived connector instances.

The runtime contract should require:

1. resolve secret handles only inside connector-session creation;
2. never place resolved values into plans, jobs, checkpoints, receipts, command envelopes, event records, or API response DTOs;
3. never attach resolved configuration to thrown errors;
4. release connector sessions as soon as the execution phase permits;
5. do not cache resolved secrets across jobs by default;
6. make connector factories accept a narrow secret resolver capability rather than a general environment object.

JavaScript cannot guarantee memory zeroization for immutable strings, so P1 must not claim cryptographic in-process erasure. The practical guarantee is scope minimization and non-persistence/non-projection.

### 3. Public/control-plane DTOs must be distinct from internal connector configuration

Returning an internal `ConnectionDescriptor` from future list/inspect endpoints is unsafe even if redaction is currently applied.

P1 needs separate types:

```text
StoredConnectionDescriptor
  = connector type + non-secret config + secretRef handles + metadata

RuntimeConnectionMaterial
  = validated config + resolved secret values
  (never serializable; connector-session scope only)

PublicConnectionProjection
  = connection name + type + bounded safe metadata + secret availability state
  (no secret value; secret reference identifier hidden by default)
```

The same separation should apply to errors, job events, receipts, connector health results, and discovery results.

### 4. Secret reference identifiers themselves are metadata and should not be universally exposed

An environment variable key such as `PROD_PAYROLL_DATABASE_PASSWORD` is not the password, but it leaks deployment topology and resource intent.

Future CLI/API/MCP inspection should therefore return secret **status** rather than the concrete environment-variable key by default:

```json
{
  "field": "password",
  "configured": true,
  "provider": "env",
  "available": true
}
```

Detailed secret-ref identifiers may be available only through an explicit local/admin diagnostic projection. They must never be placed into immutable receipts unless they are transformed into a non-reversible bounded identity that is actually necessary for audit.

### 5. Error normalization must happen before persistence or transport projection

Redacting a finished object is not sufficient if an underlying driver builds messages such as:

```text
failed connecting to postgres://user:secret@example/internal
Authorization: Bearer abc...
```

P1 needs a connector error boundary:

```text
vendor/OS/driver error
  -> connector-private error normalizer
  -> bounded SpoolError(code, safeMessage, safeDetails)
  -> control-plane persistence / API / MCP / CLI projection
```

The original exception may be retained only process-locally for an opt-in debug sink that is disabled by default and explicitly documented as potentially sensitive.

Persisted job failure records, receipts, daemon logs, API responses, and MCP tool errors must use only the safe normalized representation.

### 6. Raw rows need the same structural exclusion as credentials

The architecture says raw data remains local, but local persistence can still create an unintended secondary data store.

JobStore/checkpoint/receipt schemas must structurally prohibit:

- raw source rows;
- transformed row payloads;
- rejected rows by default;
- full sample records;
- arbitrary connector response bodies;
- SQL/API request or response dumps containing dataset values.

Allowed durable evidence should be bounded to identities, deterministic hashes, counts, schema metadata proven safe for the connector, cursor/commit evidence, verification outcomes, and normalized failure codes.

Optional rejected-row export, if added later, should be a user-selected data-plane artifact with an explicit path/connector and retention policy, not an incidental JobStore field.

### 7. Connector discovery can itself leak sensitive data

Schema names, table names, bucket paths, API endpoint names, and column names may be confidential. They are not raw rows, but they are data-plane metadata.

P1 should classify connector outputs into:

- `public-safe`: connector name/version/capability flags;
- `control-sensitive`: resource identifiers, schema/table/column metadata, row counts;
- `secret`: credentials/auth material;
- `row-data`: source/target record values.

API/MCP/CLI authorization policies can then project only the classification required by a command. Receipts should store only the minimum control-sensitive identities required to prove what resource was acted on.

### 8. Localhost is not an authentication mechanism

The architecture correctly proposes loopback binding, pairing tokens, and Origin validation. All three are required.

Before a browser bridge exists, P1 should require the following default daemon boundary:

- bind only to loopback;
- generate an unguessable runtime authentication/pairing secret;
- reject browser requests without a valid Origin allowlist and valid token;
- never accept wildcard CORS;
- never place the token in URL query strings;
- make browser pairing tokens short-lived and revocable;
- rate-limit failed pairing/authentication attempts;
- require an explicit opt-in configuration before binding to a non-loopback address;
- in non-loopback/self-hosted mode, refuse startup without a configured authentication strategy and an explicit TLS/reverse-proxy trust model.

The website's current `connect-src 'none'` must not be weakened globally merely to support the bridge. P3 should introduce an explicit paired mode with the narrowest localhost connection policy that works, while the unpaired production surface keeps its current isolation.

### 9. CLI/MCP/API should call one command boundary, not connector internals

Every external surface should submit typed commands to the same command service. None should receive a connector instance, secret resolver, JobStore handle, or raw execution context.

Required direction:

```text
CLI ----\
HTTP ----> CommandService -> policy/authz -> job runner -> connector session
MCP ----/         |
Browser bridge ---/          -> safe event/status projections
```

This prevents one transport from bypassing approval checks or exposing richer data than another.

### 10. Self-hosted mode needs explicit multi-tenant semantics or an explicit single-tenant restriction

P1 should not imply tenant isolation that does not exist.

For the first self-hosted release, the safest contract is **single administrative trust domain per daemon instance** unless a later design adds authenticated principals, per-principal connection ownership, authorization, storage partitioning, and audit attribution.

If multiple users can reach one daemon before those controls exist, credentials and dataset metadata can cross trust boundaries even if secrets are individually redacted.

## Required P1 security contracts after written-spec approval

### Secret reference contract

A secret reference is serializable; secret material is not.

```text
SecretRef -> durable/control plane allowed
ResolvedSecret -> connector session only
```

Connector schemas must explicitly identify which fields consume `SecretRef`s. Connection URLs containing embedded user-info credentials are rejected from non-secret config and must be decomposed into endpoint metadata plus secret references.

### Serialization contract

Only explicitly marked public/durable DTOs may cross JSON serialization boundaries.

A future implementation should prefer allowlisted object construction over `redact(arbitraryInternalObject)` at serialization time.

### Persistence contract

The following stores must never contain resolved secrets or raw rows:

- connection config store;
- JobStore;
- checkpoints;
- receipts;
- daemon event journal;
- default logs;
- crash-recovery records.

### Error contract

External/persisted errors contain only:

```json
{
  "code": "CONNECTOR_AUTH_FAILED",
  "message": "Authentication failed for connection 'warehouse'",
  "retryable": false,
  "phase": "CONNECT"
}
```

No vendor connection string, auth header, raw driver object, SQL parameter values, response body, source row, or stack trace appears by default.

### Receipt contract

A receipt may prove the resource and execution without reproducing secrets or row data. Resource identity should be a redacted stable identity plus connector-native non-secret evidence when needed.

### Filesystem contract

State directories and files need startup permission checks, not only creation modes. On POSIX, a pre-existing state path with unexpectedly broad permissions should fail closed or be explicitly repaired with user consent. On platforms without POSIX mode semantics, document and test the equivalent supported protection boundary.

## Verification matrix required before exposing `spoold`

After architectural approval, security tests should include at minimum:

1. secret values do not appear in persisted connection descriptors;
2. secret values do not appear in plans/jobs/checkpoints/receipts;
3. raw rows do not appear in JobStore/checkpoints/receipts/default logs;
4. nested/vendor-specific secret fields cannot enter durable config without schema-declared secret handling;
5. credentials embedded in DSNs/URLs are rejected or decomposed;
6. driver exceptions containing credentials are normalized before persistence or transport;
7. MCP/API/CLI inspect commands return public projections, not stored/runtime descriptors;
8. secret-ref identifiers are hidden by default from remote/browser/agent projections;
9. unauthenticated localhost requests fail;
10. invalid browser Origins fail even with a reachable loopback port;
11. non-loopback binding fails without explicit secure configuration;
12. two connector jobs cannot observe each other's resolved credentials;
13. connector sessions are closed on success, failure, cancellation, and recovery interruption;
14. receipts remain sufficient to verify execution without exposing raw rows or secrets;
15. existing browser production remains `connect-src 'none'` until the separately reviewed pairing increment.

## Implementation order impact after explicit written-spec approval

This audit does not change the earlier durable-execution-first sequence; it adds mandatory security acceptance criteria to it:

1. Increment A — durable contracts/state machine must use allowlisted persistent/public DTOs that cannot carry secret material or row payloads.
2. Increment B — transactional JobStore must reject forbidden payload classes and persist only normalized errors/evidence.
3. Increment C — shared runner resolves secrets only inside connector-session scope and closes sessions deterministically.
4. Increment D — command service introduces safe projections and policy boundaries before any transport exists.
5. Increment E — `spoold` loopback/auth/origin boundary, then CLI/HTTP/MCP adapters.
6. P3 — browser pairing is separately reviewed and must preserve the unpaired website's current CSP boundary.

No daemon listener, credential resolver expansion, MCP/API endpoint, browser CSP change, merge, or deployment is authorized by this audit.