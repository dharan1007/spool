# SPOOL P1 Security and Acceptance Matrix

Date: 2026-09-05
Scope: design validation and evidence gathering only. This document does not authorize architectural implementation.

## Approval gate

The written architecture spec at `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md` still records `design approved in chat; written-spec review pending`. Architectural code remains blocked until the written spec is explicitly approved in chat.

## Current verified production boundary

The current production browser surface continues to enforce a network-closed dataset execution posture:

- `connect-src 'none'` is present in the live CSP.
- `object-src 'none'`, `base-uri 'none'`, and `form-action 'none'` are present.
- HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, COOP, CORP, and a restrictive Permissions Policy are present.
- The latest production deployment is READY.
- No production runtime errors were reported by Vercel for the last 24 hours at audit time.

This browser boundary must not be weakened to introduce `spoold`. A bridge-enabled flow should use a daemon-served UI or a separately explicit bridge profile/origin.

## CI/runtime compatibility finding

There is currently a release-engine mismatch that must be resolved before P1 implementation is considered production-ready:

- `package.json` currently declares Node `>=22`.
- `.github/workflows/ci.yml` runs only Node 22.
- The P1 plan specifies Node `>=22.13.0` and built-in `node:sqlite`.
- The prior audit recommends Node 24 LTS as the production baseline because `node:sqlite` remained experimental in the Node 22 line.

Post-approval implementation must therefore choose and encode one explicit support policy:

1. **Preferred:** Node 24 LTS is the supported daemon/runtime baseline; CI must run Node 24 for P1 release gates. Browser compatibility remains independent.
2. **Optional compatibility:** Node 22 may remain a secondary compatibility lane, but daemon/SQLite production support must not be claimed from Node 22-only CI.

Do not silently change the browser package/runtime contract before the architecture gate is approved.

## P1 threat model

### Assets

- source credentials and target credentials;
- raw source rows and transformed rows;
- source and target resource identities;
- immutable migration plans;
- job state and checkpoints;
- verification evidence and receipts;
- policy approvals;
- pairing tokens and daemon authentication material.

### Trust boundaries

1. Browser-only SPOOL application.
2. Browser-to-local-daemon pairing boundary.
3. Local `spoold` process.
4. Connector process/runtime boundary.
5. Source system boundary.
6. Target system boundary.
7. Self-hosted/public network boundary.
8. Agent-client boundary through CLI/API/MCP/WebMCP.
9. Persistent local state boundary.

### Primary adversarial cases

- malicious webpage attempting localhost CSRF against `spoold`;
- DNS rebinding / Host-header confusion;
- stolen or replayed pairing token;
- path traversal or symlink escape in filesystem connector;
- connector config smuggling raw secrets into logs/receipts/errors;
- untrusted agent invoking a more destructive command than represented by the approved plan;
- stale plan executing after source/target identity or schema drift;
- checkpoint advancement before target durability;
- receipt reporting success before verification completes;
- accidental public bind with local-mode authentication assumptions;
- unrestricted SQL, shell, JavaScript, or code execution introduced through a convenience interface;
- MCP/API/CLI behavior diverging from the deterministic command service;
- connector capability declarations being bypassed by planner or runner;
- browser CSP being loosened globally for bridge support.

## Mandatory acceptance matrix

| Area | Required invariant | Minimum evidence before merge |
| --- | --- | --- |
| Plan identity | Equivalent semantic plans produce the same versioned identity; meaningful source/target/mapping/policy changes change identity | deterministic serialization tests across key order and process restart |
| Canonicalization | unsupported values are explicitly rejected or normalized; no silent `undefined`, non-finite number, `BigInt`, cycle, Date or typed-array ambiguity | focused negative tests |
| Immutability | approved plan identity cannot be mutated after creation | deep immutability or immutable serialized-record tests |
| Secret boundary | raw secret values never persist or appear in inspect/error/log/receipt payloads | recursive redaction tests with nested/error cases |
| Connector refs | only redacted identity fields and `secretRef` handles cross command boundaries | contract validation tests |
| Capability enforcement | write mode, transaction, rollback, upsert, DDL, checksum and streaming choices are rejected when undeclared | planner + executor negative tests |
| Filesystem isolation | target/source path cannot escape configured root through traversal or symlink tricks | real temp-dir traversal and symlink tests on supported OSes |
| Filesystem durability | completion is not reported before file data is flushed/closed and atomic replacement succeeds | crash/failure injection tests around temp/write/rename |
| SQLite identifiers | table/column names are validated/quoted; user strings never become raw SQL structure | injection-style identifier tests |
| SQLite transaction | checkpoint advances only after COMMIT acknowledgement | transaction failure/restart tests |
| Resume safety | resume requires matching plan revision, connector version, source snapshot assumptions and target identity | restart + drift tests |
| Verification gate | write-loop completion cannot directly enter `COMPLETE` | state-machine transition tests |
| Receipt integrity | receipt binds job, plan, source, target, checkpoint/commit identity and verification results without secrets | receipt schema + tamper/consistency tests |
| Loopback default | daemon cannot bind LAN/public interfaces by default | socket integration test |
| Host validation | invalid Host / rebinding-style requests are rejected | HTTP integration tests |
| Origin validation | browser requests from unapproved origins are rejected even with a reachable daemon | HTTP integration tests |
| Pairing token | token is scoped, expires, cannot be returned by inspect APIs and replay behavior is defined | lifecycle tests |
| Request bounds | oversized JSON/raw-row requests fail before memory amplification | HTTP size-limit tests |
| CORS | no wildcard credentialed local-daemon CORS behavior | response-header tests |
| Self-hosted profile | public listen requires explicit configuration plus authentication/policy | configuration + startup-failure tests |
| Command parity | direct command service, CLI, HTTP and MCP produce equivalent plan/job/receipt semantics | interface parity integration tests |
| MCP | stdio and Streamable HTTP both call the same command service; no hidden session-only job state | protocol integration tests |
| WebMCP | existing browser-local tools remain optional and backward compatible | current WebMCP suite + bridge boundary tests |
| Browser CSP | browser-only production keeps `connect-src 'none'` | static check + deployed header smoke test |
| Arbitrary execution | no shell/code/unrestricted-SQL primitive exists | surface audit/static tests |
| Egress attribution | network egress can originate only from explicit configured connector execution | connector/network tests |

## Pre-merge release gate after approval

Every architectural increment must satisfy all affected focused tests plus the existing browser release gate. No increment should merge on focused tests alone.

Required final command before an architectural merge remains equivalent to:

```text
npm run check
```

When P1 introduces a distinct daemon package/runtime, the release gate must expand to include daemon-specific tests while preserving the existing browser checks rather than replacing them.

## Deployment policy

- Documentation-only validation commits do not require a production deployment.
- Architectural changes must not deploy while the written spec gate remains pending.
- After approval, production deployment requires a green full release gate and security tests for the affected boundary.
- `spoold` itself should not be treated as a Vercel/browser deployment target; local and self-hosted distribution are separate from the existing static/browser product surface.

## Highest-priority next increment after explicit approval

Implement only the versioned immutable plan/identity contract first, with no connector/network/server code in the same increment. It must include strict canonicalization behavior, deep immutability, redacted connector identity binding, volatile-field exclusion, and deterministic cross-process tests. Only after that contract is stable should secret/policy contracts and connector capability enforcement follow.
