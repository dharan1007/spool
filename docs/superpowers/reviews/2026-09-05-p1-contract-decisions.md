# SPOOL P1 Pre-Implementation Contract Decisions

Date: 2026-09-05
Scope: design validation and evidence gathering only. This document does not authorize architectural implementation.

## Approval gate

The written architecture spec at `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md` still records `design approved in chat; written-spec review pending`. Architectural code remains blocked until the written spec is explicitly approved in chat.

## Why this review exists

The first post-approval increment is intended to establish immutable plan identity and the execution contracts that every later connector, daemon transport, CLI/API/MCP surface, checkpoint, and receipt will depend on. The current implementation plan is directionally correct, but a few identity/runtime rules must be explicit before code exists; otherwise those later subsystems can become mutually incompatible while each appears locally correct.

## Decision 1 — daemon runtime baseline

Use Node.js `>=24.15.0` for the P1 daemon/runtime that depends on built-in `node:sqlite`.

Rationale:

- Node 22.13 removed the `--experimental-sqlite` flag requirement but the API remained experimental.
- Current Node 24.x documentation records `node:sqlite` as release-candidate stability starting at Node 24.15.0.
- The connected Vercel browser project is already configured for Node 24.x, but the browser package/runtime contract is independent from daemon support.

Post-approval implementation should therefore avoid silently advertising generic Node 22 daemon support. If a secondary Node 22 compatibility lane is retained, it must be explicitly non-production for the built-in SQLite connector unless separately qualified and tested.

## Decision 2 — plan identity is a versioned protocol, not plain `JSON.stringify`

Every immutable migration plan MUST carry an identity version such as:

```text
identityAlgorithm: spool-plan-v1
```

The plan ID is the SHA-256 digest of a canonical identity record prefixed/domain-separated by that version. The identity record excludes volatile execution metadata and includes only semantically binding fields.

Minimum hash-bound fields:

- identity algorithm/version;
- plan revision;
- redacted source connector identity;
- redacted target connector identity;
- source snapshot/fingerprint assumptions when available;
- target schema contract;
- mapping/transformation revision;
- write strategy;
- verification policy;
- risk/policy requirements;
- connector capability assumptions that materially affect execution semantics.

Explicitly excluded from plan identity:

- `createdAt`, `updatedAt`, wall-clock timing;
- job IDs and receipt IDs;
- transient retry counters;
- resolved credentials or secret values;
- local absolute state-directory paths that do not change source/target semantics;
- logging/tracing metadata.

## Decision 3 — canonicalization must fail closed

`spool-plan-v1` canonicalization MUST define one behavior for every accepted value and reject unsupported values before hashing.

Required behavior:

- object keys: lexicographically ordered;
- arrays: order preserving;
- strings/booleans/null: accepted as JSON data;
- finite numbers: accepted with one canonical numeric representation;
- `undefined`: rejected;
- non-finite numbers (`NaN`, `Infinity`, `-Infinity`): rejected;
- `BigInt`: rejected in v1 unless first converted by a typed contract into a canonical string representation;
- cyclic graphs: rejected;
- functions/symbols: rejected;
- `Date`: rejected as an object value unless the typed contract has already converted it to an RFC 3339 string field;
- typed arrays / buffers: rejected unless the typed contract has already converted them to an explicitly tagged canonical string representation;
- custom prototypes/class instances: rejected unless first projected to a validated plain record.

No unsupported input may be silently dropped the way normal `JSON.stringify` can drop `undefined` object properties.

## Decision 4 — immutability is deep and externally observable

A plan that has received a `planId` is immutable. Top-level `Object.freeze()` alone is insufficient.

The first implementation must use one of these equivalent guarantees:

1. recursively deep-freeze the validated plan and every nested plain object/array, or
2. retain an immutable canonical serialized record as the authority and return defensive clones/views.

Tests must prove nested mapping, schema, verification, risk, source, and target fields cannot be mutated without generating a new revision/identity.

## Decision 5 — connector references are redacted identities

A connector reference crossing the command-service boundary is not a connection configuration object.

It may contain:

- connector type/name;
- stable connection descriptor ID;
- redacted endpoint/resource identity;
- database/schema/table or filesystem-relative resource identifiers;
- source snapshot/fingerprint evidence;
- `secretRef` handles when required by the command contract.

It MUST NOT contain resolved passwords, tokens, API keys, authorization headers, DSNs with embedded credentials, or arbitrary connector-private configuration blobs.

Hash identity must use the redacted semantic identity, never resolved secret material. Credential rotation must not silently create a new semantic plan when source/target identity is unchanged, while switching to a different endpoint/database/resource must.

## Decision 6 — capability assumptions bind planning to execution

Connector capabilities are enforcement inputs, not metadata for display.

The plan should persist the capability-dependent execution assumptions that materially determine the strategy, for example transactionality, upsert support, atomic replace support, checksum support, rollback availability, and pagination/snapshot semantics.

At execution time the runner must compare the connector's current manifest/version and required capabilities against the approved plan. If required capabilities disappeared or semantics changed incompatibly, execution fails closed and requires re-plan rather than silently selecting another strategy.

## Decision 7 — one command service owns mutation semantics

CLI, HTTP API, MCP stdio, MCP Streamable HTTP, and later paired WebMCP MUST invoke one transport-neutral command service. Transports may perform authentication, envelope parsing, rate/request limits, and presentation formatting, but may not independently implement migration state transitions or call connector mutation methods directly.

This is required for interface parity and receipt correctness.

## Decision 8 — current MCP target

Use the MCP TypeScript SDK v2 stable line implementing the 2026-07-28 protocol revision.

Planned packages remain:

- `@modelcontextprotocol/server` for the server surface;
- `@modelcontextprotocol/node` only for thin Node HTTP integration when required;
- a Standard Schema implementation such as Zod v4 for tool schemas.

Transports:

- stdio for local process-spawned clients;
- Streamable HTTP for self-hosted/remote clients;
- do not introduce legacy HTTP+SSE for new P1 work.

SPOOL job state remains explicit in plan/job/receipt handles rather than depending on hidden transport session state.

## Decision 9 — first post-approval test matrix

Before the first architectural commit is allowed to merge, the immutable plan slice must prove at minimum:

1. equal semantic plans with different object-key insertion order produce identical IDs;
2. the same plan produces the same ID in a fresh Node process;
3. source identity changes alter the ID;
4. target identity changes alter the ID;
5. mapping changes alter the ID;
6. verification-policy changes alter the ID;
7. risk/approval requirement changes alter the ID;
8. `createdAt` and other explicitly volatile fields do not alter the ID;
9. nested mutation is impossible or does not mutate the authoritative plan record;
10. `undefined`, non-finite numbers, `BigInt`, cycles, dates, typed arrays, functions, symbols, and custom prototypes are rejected according to the v1 contract;
11. resolved secret-shaped values are rejected from connector references and never appear in canonical identity output;
12. current browser core, transform, migration, WebMCP, worker, CSP/static checks, build, and benchmark remain green.

## Production and deployment state at review time

- Repository head before this review: `ba07a829fb654bd13bcbe9acf7931a733ccc3a2b`.
- Latest Vercel deployment for `spool-webmcp` is `READY` and targets production.
- Vercel reports no grouped runtime errors in the previous 24 hours at review time.
- The Vercel project runtime is Node 24.x.
- No daemon/data-plane deployment exists or is implied by the browser production state.

## Verification limitation for this documentation increment

The connected GitHub repository reports no commit status/check-run evidence for the previous documentation head. A local `npm run check` attempt could not be executed from this automation environment because outbound DNS access to GitHub is unavailable to the container runtime. This review therefore makes no new claim that the full release gate passed. Because this increment changes documentation only and does not modify executable/runtime behavior, no production deployment is warranted.

## Next priority after explicit written-spec approval

Implement only the versioned immutable plan/identity contract and its focused tests first. Do not combine connectors, persistence, `spoold`, HTTP, CLI, or MCP code into that commit. After the focused plan tests pass, run the complete existing `npm run check` release gate before committing architectural code. Only then proceed to secret/redaction/policy contracts and capability-enforced connector interfaces.
