# SPOOL P1 Command-Service and Transport Authorization Audit

Date: 2026-09-05
Status: design/evidence increment only; architectural implementation remains gated by explicit written-spec approval
Scope: P1 command-service boundary, local `spoold` HTTP, MCP stdio, MCP Streamable HTTP, CLI, future WebMCP bridge, self-hosted mode

## 1. Gate and purpose

The parent architecture spec at `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md` still records `Status: design approved in chat; written-spec review pending`.

Therefore this document does **not** authorize implementation. It exists to close security and interface ambiguities before any listener, command service, MCP server, CLI transport adapter, or browser bridge is introduced.

The immediate design question is:

> How can every SPOOL interface invoke one deterministic command service while ensuring that authentication, authorization, data exposure, policy approval, and execution-boundary decisions cannot be bypassed by choosing a different transport?

## 2. Current evidence

### 2.1 Browser command kernel is state-gated, not principal-authorized

`src/core/command-kernel.js` currently performs phase-aware dispatch:

- `allowed(name)` checks `toolNamesForPhase(this.workspace.job.phase)`;
- `invoke(name, args)` rejects commands unavailable in the current workflow phase;
- command execution then dispatches to `cmd_<name>`.

That is appropriate for the browser-local single-user workspace, but it is not sufficient as a daemon authorization boundary. Phase validity answers **whether an operation makes sense now**, not **who may perform it, against which resource, through which execution boundary, or with which data-view capability**.

The future daemon must not treat `kernel.allowed(name)` or MCP tool visibility as authorization.

### 2.2 Existing WebMCP registry provides useful exposure metadata

`src/webmcp/registry.js` already distinguishes:

- phase-specific tool availability;
- `readOnlyHint`;
- `untrustedContentHint` for bounded source/result access;
- bounded sample limits;
- no arbitrary JavaScript transform primitive.

Those properties should be preserved, but daemon-facing interfaces require a second dimension: actor/capability authorization. A tool can be both phase-valid and unauthorized for a caller.

### 2.3 Existing threat model does not yet include the daemon boundary

`docs/THREAT_MODEL.md` currently models browser CSV, WebMCP arguments, Worker messages, IndexedDB, and CSV export hazards. P1 introduces new trust boundaries that are not yet represented there:

1. process-spawned stdio clients;
2. loopback HTTP callers;
3. browser-to-loopback requests susceptible to DNS rebinding and cross-origin abuse;
4. self-hosted remote HTTP callers;
5. long-lived daemon state shared across commands;
6. command results that may include redacted metadata or explicitly bounded raw rows;
7. connector network egress and credential resolution;
8. policy/approval provenance.

The threat model must be expanded before daemon release.

## 3. Primary conclusion

SPOOL needs a **transport-neutral authorization envelope** in front of the shared command service.

No transport may directly call connector methods, JobStore mutation methods, receipt finalization, or the browser `CommandKernel` as an authorization shortcut.

Required conceptual call path:

```text
CLI / MCP stdio / HTTP API / MCP HTTP / paired WebMCP
                    |
                    v
            Transport adapter
                    |
            authenticate caller
                    |
            build RequestContext
                    |
                    v
          Command Service authorize
                    |
          policy + state + capability
                    |
                    v
       deterministic platform operation
                    |
          connector / runner / store
                    |
                    v
        redacted result projection
```

Authentication establishes caller identity/trust context. Authorization is performed again inside the shared command service against the requested operation and resources.

## 4. Required RequestContext

Every command invocation should carry a runtime-only context similar to:

```ts
interface RequestContext {
  requestId: string;
  transport: 'cli' | 'stdio' | 'http' | 'mcp_http' | 'webmcp_bridge';
  principal: {
    kind: 'local_user' | 'local_process' | 'paired_browser' | 'service' | 'remote_user';
    id: string;
  };
  authn: {
    method: 'process' | 'pairing_session' | 'bearer' | 'oauth';
    authenticated: boolean;
  };
  capabilities: Set<SpoolCapability>;
  boundary: {
    local: boolean;
    selfHosted: boolean;
    browserOrigin?: string;
  };
  policyRef?: string;
}
```

This object is ephemeral. It is not copied wholesale into plans, jobs, logs, receipts, or connector configuration.

A minimal audit projection may persist stable non-secret provenance such as principal class, approved policy identity/hash, and transport class when required for a receipt.

## 5. Capability model

P1 should avoid a broad `admin=true` flag as the only authorization primitive. Capabilities should be intent-level and composable.

Minimum candidate capabilities:

```text
connectors:list
connections:inspect
connections:test
connections:manage
sources:discover
sources:sample
plans:create
plans:inspect
plans:approve
jobs:run
jobs:inspect
jobs:pause
jobs:resume
jobs:abort
jobs:verify
receipts:read
rows:preview
rows:export
```

Raw-row access is intentionally separate from metadata inspection. A principal permitted to inspect job state or receipts does not automatically gain `rows:preview` or `rows:export`.

Connector credentials are never exposed as a capability result; callers can only reference stored connections or provide permitted secret references.

## 6. Authorization decision inputs

A command-service authorization decision must combine all of:

1. authenticated principal/context;
2. required command capability;
3. target connection/job/plan ownership or trust-domain membership;
4. current job/plan state;
5. connector-advertised capabilities;
6. plan risk classification;
7. required approval events;
8. configured policy file;
9. requested execution boundary and egress implications.

A positive result from one layer cannot override a negative result from another.

For example, `jobs:run` is insufficient when the plan still requires `target_overwrite` approval or when the selected connector does not support the chosen write strategy.

## 7. Tool visibility is not authorization

MCP/WebMCP tool listing should be filtered to improve safety and usability, but hidden tools must still be rejected if invoked directly.

The command service remains authoritative.

This avoids the class of bug where:

- an old MCP client caches a previously visible tool;
- a client constructs a raw JSON-RPC call;
- an API caller bypasses MCP listing;
- a CLI subcommand remains installed while policy changes.

Expected ordering:

```text
parse envelope
-> authenticate
-> validate command schema
-> authorize capability/resource
-> validate state transition
-> evaluate policy/approval
-> execute
-> project/redact result
```

## 8. Local HTTP security requirements

Loopback binding alone is not an authentication mechanism.

For default local `spoold` HTTP:

- bind only to `127.0.0.1` and/or `::1` by default;
- reject unexpected `Host` values;
- validate `Origin` whenever present;
- apply explicit localhost allowlists rather than permissive wildcard CORS;
- require authentication for mutation and sensitive metadata endpoints;
- never accept credentials/tokens in URL query parameters;
- do not persist access tokens in browser `localStorage`;
- prevent authentication tokens from entering logs, receipts, crash messages, telemetry, or error details;
- enforce request-body and response-size limits;
- apply timeouts and bounded concurrency before connector execution;
- keep raw-row endpoints explicit and separately authorized.

Current MCP SDK guidance treats Host/Origin validation as the DNS-rebinding defense for localhost HTTP servers. SPOOL should use the SDK/framework protection when available and retain an explicit integration test so a dependency/configuration change cannot silently disable it.

## 9. Pairing-token lifecycle

A browser pairing token should be a **bootstrap credential**, not a reusable daemon bearer token.

Recommended lifecycle:

1. daemon creates a high-entropy, short-lived, single-use pairing code/token;
2. user explicitly initiates pairing and sees daemon identity/endpoint/permissions;
3. browser presents the bootstrap credential over the allowed loopback origin;
4. daemon validates token + Origin + expiry + one-time state;
5. daemon consumes the bootstrap token atomically;
6. daemon issues a short-lived scoped pairing session credential;
7. subsequent browser calls use that scoped credential;
8. disconnect/revoke/daemon restart invalidates the pairing session unless explicitly persisted under a secure design.

Requirements:

- bootstrap token must not appear in the URL;
- comparison should be constant-time where applicable;
- replay after successful consumption must fail;
- multiple simultaneous redemption attempts must produce exactly one success;
- pairing does not grant raw-row access unless that permission is explicitly displayed and granted;
- pairing cannot silently widen from localhost to a remote/self-hosted server.

## 10. CLI and MCP stdio trust model

`stdio` is materially different from network HTTP.

For a locally spawned CLI/MCP process:

- do not run an HTTP OAuth flow merely to call the child process;
- treat process launch/configuration as the authentication boundary;
- resolve any required service credentials from approved environment/secret references;
- never print resolved secrets to stdout because stdout is protocol/application output;
- protocol logs belong on stderr and must still be redacted;
- machine-readable CLI JSON must use the same public result DTOs as other interfaces;
- stdio transport does not bypass command-service authorization or policy evaluation.

The process principal should still receive a bounded capability set derived from launch configuration/policy.

## 11. MCP Streamable HTTP

SPOOL should target the current MCP protocol direction rather than legacy HTTP+SSE.

Design requirements:

- Streamable HTTP only for new remote/self-hosted MCP exposure;
- stateless request handling where practical; SPOOL job state belongs in durable SPOOL stores, not hidden MCP transport session state;
- explicit plan/job/receipt handles in tool arguments/results;
- Host/Origin protection for localhost-class binds;
- authorization on every HTTP request;
- token audience/resource validation for protected remote MCP;
- no bearer token in URI query strings;
- capability filtering of `tools/list` plus authoritative command-level enforcement;
- protocol-version handling isolated from SPOOL job-state semantics.

For standards-compatible self-hosted remote MCP, SPOOL should act as an OAuth-protected resource server rather than inventing a proprietary remote login protocol. OAuth issuer/resource/audience checks and protected-resource metadata belong at the transport/authentication layer; SPOOL operation capabilities still belong at the command-service layer.

P1 may support a documented single-trust-domain deployment first, but it must not label a static shared bearer secret as full multi-user authorization.

## 12. HTTP API boundary

The generic `/v1` API and `/mcp` are separate protocol surfaces over the same command service.

The `/v1` API should:

- use versioned typed envelopes;
- expose redacted metadata by default;
- avoid unrestricted SQL or arbitrary connector passthrough endpoints;
- return raw rows only from explicit bounded endpoints requiring `rows:preview`/`rows:export`;
- use idempotency keys for creation/mutation operations where replay could duplicate effects;
- return stable typed error codes without connector exception dumps;
- apply auth before route handlers can reach connector or store mutation code.

Transport-specific status codes do not change platform error identity. For example, HTTP may use `401/403/409`, while CLI/MCP map the same underlying SPOOL error into their own envelope.

## 13. Self-hosted mode

First-release self-hosted mode should be explicitly scoped as one administrative trust domain unless durable tenant isolation is implemented and tested.

Required configuration when binding beyond loopback:

- explicit listen address;
- explicit allowed hosts/origins;
- TLS or documented TLS-terminating reverse proxy;
- configured authentication provider/validator;
- explicit policy file;
- explicit state directory;
- explicit connector egress policy;
- startup failure when required security configuration is missing.

`0.0.0.0` must never silently downgrade Host/Origin validation or authentication.

## 14. Command-service projections

Internal runtime objects must not be returned directly.

Define separate projections such as:

```text
StoredConnectionDescriptor  -> internal persisted secret references
RuntimeConnectionSession    -> contains resolved secret handles; never serialized
PublicConnectionDescriptor  -> no secret values and normally no secret-ref identifiers
JobRecord                    -> internal execution metadata
PublicJobView                -> redacted inspect result
ReceiptRecord                -> immutable evidence; no raw rows/secrets
```

The command service is responsible for returning public DTOs. Transport adapters serialize those DTOs; they do not perform ad-hoc redaction.

This is necessary because transport-specific redaction eventually diverges and creates leakage paths.

## 15. Error boundary

No raw connector exception crosses the command-service boundary.

Connector errors should be normalized to fields such as:

```text
code
category
retryable
operation
connector
safeMessage
safeDetails
```

Never persist/return:

- DSNs containing credentials;
- authorization headers;
- raw SQL generated internally for connector operation;
- raw input rows in generic error objects;
- environment-variable values;
- stack traces to untrusted clients.

Detailed local diagnostics may include stack traces only in a controlled diagnostic sink after secret/data scrubbing.

## 16. Approval provenance

Risk approval must be represented as an auditable event, not a transient boolean supplied by the same untrusted command arguments that request execution.

Candidate approval evidence:

```text
approvalId
planId
planRevision
riskCode
principalClass/principalId
policyHash (when policy-preauthorized)
approvedAt
expiresAt or one-shot semantics
```

Execution verifies approval binding to the exact immutable plan revision. Any plan revision that changes destructive effects invalidates previous approval unless policy explicitly proves equivalence.

## 17. TOCTOU and confused-deputy protections

Before performing a mutating connector operation, the runner must re-bind/check:

- immutable plan identity;
- current connection descriptor revision;
- source snapshot assumptions;
- target identity;
- required approval identity;
- execution epoch/lease;
- connector capabilities.

The daemon must not become a confused deputy that accepts an authorized connection name and then lets command arguments substitute an arbitrary path/host/resource outside that connection's validated scope.

Filesystem root confinement is one example; future REST/S3/database connectors require equivalent resource-scope checks.

## 18. Idempotency and replay

Network/API/MCP retries can duplicate requests. Mutations must therefore have explicit replay behavior.

At minimum:

- plan creation should be deterministic/content-addressed where already designed;
- job creation/run requests need an idempotency identity or existing-job handle;
- pause/resume/abort should have idempotent terminal behavior;
- pairing redemption is single-use;
- approval consumption semantics must be defined;
- receipt finalization is immutable/content-addressed and must reject divergent re-finalization.

## 19. Required security tests before implementation can be considered production-ready

### Shared command service

- unauthenticated context cannot invoke protected commands;
- caller with metadata capability cannot obtain raw rows;
- hidden/cached MCP tool still fails command authorization;
- phase-valid but capability-invalid command fails;
- capability-valid but policy-invalid run fails;
- approval bound to old plan revision fails;
- public DTO contains neither raw secret values nor secret-ref identifiers;
- normalized errors exclude secret/raw-row sentinel values.

### Local HTTP

- default listener binds loopback only;
- malicious `Host` rejected before dispatch;
- foreign browser `Origin` rejected before dispatch;
- missing/invalid auth rejected;
- pairing token in query string rejected;
- pairing token replay rejected;
- simultaneous pairing redemption yields one success;
- wildcard CORS absent;
- oversized body rejected before platform execution.

### MCP HTTP

- bearer/OAuth credential required when configured;
- token audience/resource mismatch rejected;
- each request independently authorized;
- tool listing filtered by principal capability;
- direct call to non-visible tool still rejected;
- job semantics survive transport restart because state is durable outside transport sessions.

### stdio/CLI

- secrets never emitted to stdout/stderr under sentinel test values;
- JSON output matches command-service public DTO;
- launch capability restrictions enforced;
- same plan/job/receipt terminal identity as direct command service.

### Self-hosted

- non-loopback bind without explicit security config fails startup;
- allowed-host mismatch rejected;
- TLS/reverse-proxy mode is explicit;
- tenant claims are not advertised until true isolation tests exist.

## 20. Release sequencing implication

After explicit approval of the parent written architecture, implementation should still proceed in this order:

1. runtime-neutral job/receipt/recovery contracts and structural public/internal DTO separation;
2. durable transactional JobStore with state versions and execution fencing;
3. shared command service with `RequestContext`, capability authorization, policy/approval validation, and result projections;
4. real source-to-target runner through that command service;
5. CLI + MCP stdio adapters;
6. loopback HTTP API with Host/Origin/auth controls;
7. MCP Streamable HTTP using the same auth/command boundary;
8. only then browser pairing/WebMCP bridge;
9. self-hosted packaging after non-loopback startup/security tests.

This is deliberately more conservative than adding `spoold` routes immediately. Once a network/agent surface exists, retrofitting authorization beneath transport handlers is both riskier and more likely to create bypasses.

## 21. Decision summary

The next implementation must satisfy these invariants:

1. **Transport is never authority.** CLI, MCP, HTTP and WebMCP all call one authorized command service.
2. **State gating is not authorization.** Workflow phase checks remain necessary but separate.
3. **Tool visibility is not authorization.** Hidden tools still fail if called directly.
4. **Raw-row access is a distinct capability.** Metadata/read-only does not imply dataset visibility.
5. **Loopback is not authentication.** Local HTTP still requires Host/Origin protection and authenticated sensitive operations.
6. **Pairing is explicit, scoped and replay-resistant.** Bootstrap tokens are one-time and short-lived.
7. **Remote MCP follows MCP/OAuth standards.** Do not invent a proprietary remote auth scheme.
8. **Internal objects never become transport responses.** Public DTOs are structurally secret/data-safe.
9. **Approvals bind immutable plan revisions.** A command argument cannot self-approve its own destructive operation.
10. **No listener is implemented before the durable store/command boundary is sound.**

Until the parent written architecture is explicitly approved in chat, these remain design requirements only and must not be converted into architectural runtime code.