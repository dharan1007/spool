# SPOOL P1 Pre-Implementation Audit

Date: 2026-09-05
Scope: design validation and evidence gathering only. No architectural implementation is authorized by this note.

## Approval gate

The architecture spec at `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md` currently records `design approved in chat; written-spec review pending`. Treat P1 architectural code as blocked until the written spec is explicitly approved in chat.

## Repository baseline

- Current semantic/product implementation is still browser-first: `src/core`, `src/runtime`, `src/storage`, `src/webmcp`, `src/worker`, and `src/app.js`.
- `package.json` has no runtime dependencies and currently supports Node `>=22`; the release gate is `npm test && npm run build && npm run benchmark && node scripts/static-check.js`.
- No `src/platform`, `src/connectors`, `src/daemon`, CLI, HTTP API, or standard MCP server implementation exists yet on `main`.
- Latest architecture commits are documentation-only: hybrid platform design followed by the P1 implementation plan.
- GitHub currently reports no commit status/check-run evidence for the latest documentation commit, so green CI must not be inferred from repository status alone.

## Production baseline

- Vercel project `spool-webmcp` is present and the latest production deployment is READY.
- Production remains the browser/static product surface; no daemon/server data plane is deployed or implied by this state.
- No speculative architecture deployment should occur before the written spec gate and local release checks are satisfied.

## External compatibility evidence

### MCP

The current MCP TypeScript SDK v2 is the stable release line for the 2026-07-28 protocol revision. The P1 plan's split-package direction is valid:

- `@modelcontextprotocol/server` for server functionality;
- `@modelcontextprotocol/node` only as the thin Node HTTP adapter when needed;
- Zod v4 or another Standard Schema implementation for tool schemas;
- stdio plus Streamable HTTP, not legacy SSE, for new work.

Implementation should pin compatible major/minor ranges and add protocol-level integration tests instead of relying on package presence.

### Node SQLite

`node:sqlite` is available without the experimental flag from Node 22.13, but remained experimental in that line. Newer Node releases have continued hardening it; current Node 24 is LTS and the connected Vercel project is configured for Node 24.x.

**Recommendation:** P1 should use Node 24 LTS as its production baseline, while deciding separately whether CLI/local compatibility with Node 22 is worth supporting. If Node 22 compatibility is retained, the plan must explicitly accept the `node:sqlite` stability tradeoff rather than describing the connector as production-grade without qualification.

## Highest-impact design corrections before code

1. **Separate browser compatibility from daemon runtime requirements.** Keep the current browser build dependency-light. P1 daemon/MCP dependencies must not leak into browser bundles or weaken the browser CSP.
2. **Define a single command-service boundary before connector code.** CLI, HTTP, MCP, and later WebMCP bridge must call the same command service; none may directly invoke connector internals.
3. **Make execution identity explicit before persistence.** Plan ID, plan revision, job ID, checkpoint identity, and receipt ID need canonical serialization rules before a durable store is added.
4. **Treat secrets as handles at every API boundary.** Connector descriptors may carry `secretRef`; resolved secret values may exist only inside the execution context and must be recursively redacted from errors/logs/receipts.
5. **Do not let connector capability declarations become advisory.** Planner and executor need hard capability checks for write mode, transactionality, rollback, DDL, upsert, checksum, and streaming.
6. **Filesystem writes need crash semantics, not just temp+rename.** The implementation plan should include parent-directory durability considerations, overwrite policy, symlink/path traversal defenses, and Windows rename behavior in tests.
7. **SQLite needs explicit transaction/checkpoint semantics.** A checkpoint cannot advance before the target transaction is committed; resume must validate source snapshot assumptions and target identity.
8. **Verification must be a terminal state-machine gate.** `COMPLETE` is unreachable until configured verification succeeds. A finished write loop is only `WRITTEN`/`VERIFYING`, never success by itself.
9. **Local HTTP security should be specified before server creation.** Loopback binding, Host/Origin validation, pairing-token lifetime, CORS behavior, request-size limits, and raw-row endpoint policy need tests before exposing an HTTP surface.
10. **Self-hosted mode must be an explicit profile.** Public binding must require explicit configuration plus authentication/policy; local defaults must never silently carry into a public deployment.

## Recommended implementation order after explicit written-spec approval

1. Runtime-neutral immutable plan/identity contracts plus tests.
2. Secret-reference/redaction/policy contracts plus tests.
3. Connector capability contract/registry plus tests.
4. Real filesystem connector with path and crash-safety tests.
5. Real SQLite connector with transaction and identifier-hardening tests.
6. Source-to-target runner and verification state machine.
7. Durable job/checkpoint/receipt store and restart recovery.
8. One command service over the runner.
9. CLI parity.
10. Loopback `spoold` HTTP API with strict security defaults.
11. MCP stdio, then Streamable HTTP, both invoking the same command service.
12. Self-hosted packaging/profile.
13. Browser/local bridge only after the daemon boundary is proven; preserve the existing network-closed browser mode.

## First post-approval increment

The safest first code increment remains the immutable platform-plan identity slice, but it should be tightened before implementation:

- canonical JSON must reject or define behavior for `undefined`, non-finite numbers, `BigInt`, dates, typed arrays, and cycles;
- the plan hash must explicitly version its canonicalization algorithm (for example `spool-plan-v1`) so future serialization changes do not silently alter identity semantics;
- connector refs must define exactly which redacted identity fields are hash-bound;
- `createdAt` and other volatile fields must stay outside identity;
- plan objects should be deep-frozen or treated as immutable serialized records, not only top-level frozen;
- tests must prove equivalent plans hash identically across property order and process restarts, while meaningful source/target/mapping/policy changes alter the ID.

No implementation or deployment was performed in this audit.