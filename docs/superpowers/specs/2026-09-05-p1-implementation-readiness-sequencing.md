# SPOOL P1 Implementation Readiness and Sequencing

Date: 2026-09-05
Status: design/decomposition evidence only; architectural implementation remains gated by explicit approval of `2026-09-05-hybrid-local-bridge-platform-design.md`

## 1. Purpose and gate

The parent architecture spec still records `Status: design approved in chat; written-spec review pending`.

This document does not authorize architectural code. It consolidates the P1 audits into one implementation-ready dependency order so that, after explicit approval, SPOOL can advance without exposing `spoold`, MCP, API, CLI, or browser pairing on top of incomplete durability or security semantics.

## 2. Current evidence consolidated

P1 already has useful implementation scaffolding and real connector work on the draft branch:

- deterministic platform contracts and plan hashing;
- connector contract/registry;
- real filesystem connector;
- real SQLite connector;
- secret-reference/config scaffolding;
- file-backed JobStore and receipt scaffold;
- connector and platform tests.

The audits identify four classes of blockers before an outward-facing daemon is safe:

1. **Durability/recovery** — no transactional stateVersion CAS, execution epoch/lease fencing, `RECOVERING`/`RECOVERY_REQUIRED`, or recoverable receipt-to-terminal linkage in the current JobStore.
2. **Credential/data isolation** — secret resolution and public/internal DTO boundaries need structural guarantees rather than best-effort redaction; raw rows must not leak into jobs, receipts, errors, logs, or default inspection projections.
3. **Authorization** — workflow phase/tool visibility is not caller authorization; every transport must use one authenticated/authorized command-service path.
4. **Transport exposure** — loopback HTTP, MCP HTTP, paired WebMCP, and self-hosted listening cannot be enabled until Host/Origin/authentication/capability/policy boundaries are enforced and tested.

## 3. Dependency rule

The implementation order MUST follow safety dependencies, not UI/API visibility.

A later layer may depend only on invariants already enforced and tested by earlier layers.

```text
A. runtime contracts + public/internal DTO separation
        |
        v
B. transactional durable execution store
        |
        v
C. recovery/finalization protocol
        |
        v
D. shared real source -> target runner
        |
        v
E. transport-neutral authorized command service
        |
        v
F. CLI + MCP stdio
        |
        v
G. local spoold HTTP/API
        |
        v
H. MCP Streamable HTTP / self-hosted mode
        |
        v
I. browser pairing / paired WebMCP
```

Connector work may continue only where it does not require bypassing these boundaries. Existing deterministic kernel and browser flow remain authoritative compatibility constraints throughout.

## 4. Increment A — runtime contracts and isolation types

Implement only after explicit parent-spec approval.

Required outcomes:

- immutable job/plan/checkpoint/verification/receipt contracts;
- explicit states including `RECOVERING` and `RECOVERY_REQUIRED`;
- `stateVersion` and execution-epoch ownership fields in durable job contracts;
- one canonical cumulative progress representation;
- stable batch/commit identity contracts;
- public DTOs separated from internal runtime/connector/session objects;
- secret-bearing resolved values represented by types that cannot be serialized into plan/job/receipt/public results;
- raw row batches excluded from durable metadata structures;
- normalized error envelope that can carry safe error class/code/context without connector-native secret-bearing details.

Acceptance gate:

- contract tests prove invalid transitions/terminal states fail closed;
- JSON serialization tests prove secret-bearing/runtime-only types cannot enter durable/public DTOs;
- existing browser/WebMCP tests remain green.

STOP if these guarantees require breaking the current deterministic kernel rather than adapting behind interfaces.

## 5. Increment B — transactional durable execution store

Replace the file-backed JobStore as the daemon execution authority with a transactionally enforced store, preferably SQLite for P1.

Required outcomes:

- schema versioning/migrations;
- optimistic CAS on `stateVersion`;
- execution epoch/lease fencing;
- atomic checkpoint + progress counter mutation;
- unique immutable receipt insertion;
- durable receipt/job linkage;
- append-only recovery/incident evidence for ambiguous commits;
- identity binding to plan/source/target/connector versions;
- explicit supported SQLite durability configuration and startup validation.

Acceptance gate:

- two writers cannot both commit the same expected version;
- stale execution epochs cannot mutate a job;
- checkpoint/progress divergence is impossible by schema/transaction;
- divergent receipt overwrite is impossible;
- corrupted metadata fails closed;
- restart preserves committed state under supported durability assumptions.

No shared runner or network listener may depend on the store before this gate passes.

## 6. Increment C — recovery and terminal finalization

Required outcomes:

- commit-before-checkpoint ambiguity enters `RECOVERING`/`RECOVERY_REQUIRED` rather than blindly retrying;
- filesystem and SQLite target reconciliation use stable batch/write identities;
- source snapshot/plan/target/connector drift blocks unsafe resume;
- finalization sequence is recoverable and idempotent:

```text
verification succeeds
-> immutable receipt persists
-> terminal linkage commits
-> COMPLETE becomes observable
```

- failure and recovery receipts remain immutable evidence without falsely marking success.

Acceptance gate:

Fault-injection tests cover at minimum:

- crash before target commit;
- crash after target commit before checkpoint;
- ambiguous commit response;
- crash after checkpoint;
- crash after receipt insertion before terminal linkage;
- repeated recovery/finalization;
- stale runner trying to resume after ownership transfer.

## 7. Increment D — shared real source-to-target runner

Only after A-C are green.

Required first real workflows:

1. JSONL -> SQLite;
2. SQLite -> JSONL;
3. SQLite -> SQLite.

Runner invariants:

- consumes connector batches without full-dataset materialization;
- uses deterministic transformation/validation logic from the existing kernel/core;
- never advances durable checkpoint before target acknowledgment/reconciliation;
- verification policy must pass before terminal success;
- every connector operation receives runtime-only credential/session context;
- no arbitrary SQL/JavaScript/code execution primitive;
- cancellation/pause uses bounded deterministic boundaries rather than process kill as correctness control.

Acceptance gate:

- each workflow produces a verified immutable receipt;
- pause/resume and restart work from durable checkpoints;
- schema/source drift rejects resume;
- source/target counts and hashes/sample evidence match configured verification policy;
- memory behavior remains bounded for streamed input.

## 8. Increment E — authorized command service

The command service becomes the only application-level mutation entrypoint for future interfaces.

Required outcomes:

- authenticated `RequestContext` built per invocation;
- intent-level capabilities;
- resource/trust-domain/state/connector/risk/policy/approval checks;
- immutable plan revision bound to approvals;
- public result projection/redaction after execution;
- direct connector/store mutation not reachable from transports;
- bounded raw-row preview/export requires separate capability.

Acceptance gate:

- hidden/unlisted tools still reject unauthorized direct invocation;
- one principal cannot gain additional capability by switching CLI/API/MCP transport;
- approval for plan revision N cannot authorize revision N+1;
- secret values and raw rows stay absent from default inspect/status/receipt surfaces.

## 9. Increment F — CLI and MCP stdio first

Prefer process-local interfaces before opening HTTP.

Required outcomes:

- machine-readable CLI uses the same public DTOs as command service;
- MCP stdio uses intent-level tools only;
- protocol output never contains resolved secrets;
- stderr logging is redacted;
- both interfaces invoke exactly the same command-service operations.

Acceptance gate:

The same prepared migration produces equivalent plan/job/receipt identity and terminal state through direct command-service invocation, CLI, and MCP stdio.

## 10. Increment G — local `spoold` HTTP/API

Only after A-F pass.

Default security posture:

- loopback-only bind;
- authenticated mutation/sensitive metadata operations;
- strict Host validation;
- strict Origin validation when present;
- no wildcard CORS;
- no tokens in URLs;
- bounded body/response sizes and concurrency;
- explicit raw-row permissions;
- connector/network egress attributable to configured connectors only.

Acceptance gate:

- public/LAN bind fails unless explicitly configured;
- DNS-rebinding/Host/Origin tests fail closed;
- unauthenticated mutation fails;
- malformed/oversized requests fail before connector execution;
- no browser-production CSP change is required for normal browser-only SPOOL.

## 11. Increment H — MCP Streamable HTTP and self-hosted mode

Required outcomes:

- current MCP Streamable HTTP transport;
- protected remote operation uses protocol-appropriate authentication/resource-server semantics;
- first P1 self-hosted release is explicitly one trust domain unless tenant isolation is separately designed and tested;
- non-loopback startup fails closed unless authentication, host/origin policy, TLS or trusted reverse-proxy posture, state directory, and egress policy are explicitly configured;
- configuration inspection never reveals resolved credentials.

Acceptance gate:

- remote principal/capability tests;
- cross-origin/host rejection tests;
- trust-domain boundary documented and enforced;
- self-hosted restart/recovery uses the same durable store semantics as local mode.

## 12. Increment I — paired browser/WebMCP bridge

This remains last because the production browser currently provides a strong `connect-src 'none'` dataset-execution boundary.

Required outcomes:

- normal production/browser-only mode preserves `connect-src 'none'`;
- pairing uses an explicit separate bridge-enabled origin/profile or daemon-served local UI rather than globally weakening CSP;
- bootstrap pairing token is short-lived, high-entropy, single-use, replay-safe, and not placed in URLs/localStorage;
- successful pairing issues only scoped short-lived session authority;
- UI visibly identifies local daemon execution boundary and permissions;
- paired WebMCP still invokes the command service rather than connectors directly.

Acceptance gate:

- normal web build remains network-closed for dataset execution;
- pairing replay/race tests allow exactly one redemption;
- browser origin and daemon identity are displayed/validated;
- pairing cannot silently widen to remote/self-hosted execution.

## 13. Backward compatibility gate on every increment

Every increment must preserve:

- existing deterministic transformation behavior;
- browser CSV workflow;
- existing WebMCP behavior/tool compatibility unless versioned compatibility is provided;
- current CSP/security boundary for normal production browser mode;
- existing plan/revision semantics where already externally observable.

Each PR/commit must run the existing release gate in addition to increment-specific tests.

If a new architecture layer requires a breaking change, stop and document a migration/compatibility plan before proceeding.

## 14. Commit and deployment policy

After explicit approval:

- implement one increment at a time;
- tests first for new invariants;
- commit only green increments;
- keep PR draft until the active increment and regression gate are green;
- do not merge merely because scaffolding compiles;
- do not deploy local-daemon architectural work to the browser production site unless that deployment intentionally changes the browser product and separately passes CSP/security review;
- never deploy speculative/failing changes.

## 15. Current go/no-go matrix

| Layer | Design ready | Safe to implement now | Safe to expose publicly |
| --- | --- | --- | --- |
| Existing browser product | yes | maintenance only | yes, existing deployment |
| Connector contract/filesystem/SQLite scaffold | largely yes | no new architectural work until parent-spec approval | no daemon exposure |
| Runtime isolation contracts | specified by audits | no | no |
| Transactional JobStore/recovery | specified sufficiently for next increment | no | no |
| Shared runner | dependency order defined | no | no |
| Command service authorization | design audited | no | no |
| CLI/MCP stdio | surface defined | no | no |
| Local HTTP `spoold` | security requirements defined | no | no |
| Self-hosted/MCP HTTP | bounded design direction | no | no |
| Browser pairing/WebMCP bridge | high-level architecture defined | no | no |

The only reason the first post-approval increment is blocked is the explicit written-spec approval gate, not lack of a safe implementation sequence.

## 16. Next action

Until the parent written spec is explicitly approved in chat: continue only audits/evidence gathering and keep production unchanged.

Immediately after explicit approval: start Increment A, then Increment B. Do not jump directly to `spoold`, HTTP, MCP HTTP, or browser pairing even if those surfaces are more visible; the durable and isolation invariants are prerequisites for production quality.
