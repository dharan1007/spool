# SPOOL P1 Implementation-Plan Reconciliation

Date: 2026-09-05
Scope: audit, design validation, decomposition, and evidence gathering only. This document does not authorize architectural implementation.

## Approval gate

The written architecture spec at `docs/superpowers/specs/2026-09-05-hybrid-local-bridge-platform-design.md` still records `Status: design approved in chat; written-spec review pending`. No architectural/runtime code may be implemented until that written spec is explicitly approved in chat.

## Purpose

The existing P1 implementation plan predates the stricter contract/security decisions captured in the subsequent reviews. Before any post-approval implementation begins, the plan itself must be treated as partially stale: several sample snippets and runtime assumptions would violate the now-agreed fail-closed design if copied literally.

This reconciliation records the required deltas so implementation does not accidentally regress from the approved design while following an older task plan.

## Reconciliation 1 — runtime baseline

Current evidence:

- `package.json` advertises `node >=22`.
- `.github/workflows/ci.yml` validates only Node 22.
- the P1 implementation plan says Node `>=22.13.0` and uses built-in `node:sqlite`.
- the contract decision record establishes Node `>=24.15.0` as the production P1 daemon baseline for built-in `node:sqlite`.
- the Vercel browser project currently runs Node 24.x, but that does not validate the daemon runtime.

Required plan correction after written-spec approval:

1. daemon/runtime package support must require Node `>=24.15.0` for production P1;
2. CI must contain a Node 24.15+ production validation lane before daemon code can be called release-ready;
3. Node 22 may remain only as an explicitly secondary compatibility lane for the existing browser package if desired;
4. browser compatibility and daemon runtime support must not be conflated in one ambiguous engine claim.

No `package.json` or CI code/config is changed by this review because the architecture gate is still closed.

## Reconciliation 2 — canonical JSON sample is unsafe and must not be implemented literally

The current Task 1 sample uses a recursive key-sort followed by `JSON.stringify`. That is insufficient for `spool-plan-v1` because normal JavaScript serialization can silently omit or normalize values that the contract now requires SPOOL to reject.

The post-approval implementation must reject before hashing:

- `undefined` anywhere in the authoritative identity record;
- non-finite numbers;
- `BigInt` unless converted by an explicit typed contract;
- cycles;
- functions and symbols;
- `Date` objects unless converted to an explicit string field by validation;
- buffers/typed arrays unless converted to a tagged canonical representation;
- class instances or custom-prototype objects.

It must also define one canonical finite-number representation and preserve array order. A silent drop is an identity collision risk and therefore a release blocker.

## Reconciliation 3 — plan identity requires domain separation and an explicit identity record

The current sample hashes a clone of the input plan after deleting `createdAt` and `planId`. That is too implicit.

The implementation must instead build a validated, explicit identity record with an algorithm marker such as `spool-plan-v1`, then hash only fields designated as semantically binding.

At minimum the identity record binds:

- identity algorithm/version;
- plan revision;
- redacted source identity and source snapshot/fingerprint assumptions;
- redacted target identity;
- target schema contract;
- mapping/transformation revision;
- write strategy;
- verification policy;
- risk/policy requirements;
- capability assumptions that determine execution semantics.

Volatile execution metadata must be excluded by construction rather than by ad-hoc deletion.

## Reconciliation 4 — immutability must be deep

The current Task 1 sample returns `Object.freeze({ ... })`, which only freezes the outer object.

Post-approval implementation must either:

- recursively deep-freeze the validated plan's nested plain objects/arrays; or
- retain the canonical immutable serialized record as authority and expose only defensive views/clones.

Tests must attempt mutation of nested mapping, schema, verification, risk, source, target, write-strategy, and capability-assumption fields and prove that the authoritative plan cannot change without a new revision/identity.

## Reconciliation 5 — connector-reference secret rejection must be structural, not key-name-only

The current sample rejects only direct `secret`, `password`, or `token` properties. That is not sufficient for a credential isolation boundary.

The connector reference validator must:

- allow a typed `secretRef` handle only where the schema permits it;
- reject resolved secrets nested at any depth;
- reject credential-bearing DSNs/URLs where userinfo contains a password/token;
- reject raw authorization headers and arbitrary opaque connector-private config from crossing the command-service identity boundary;
- normalize/redact endpoint identity before plan hashing, receipts, inspection, errors, or logs.

Credential rotation must not alter semantic plan identity when resource identity is unchanged, but changing endpoint/database/resource must.

## Reconciliation 6 — connector capabilities require versioned semantics

The current connector-plan task mostly validates that capability keys exist. P1 needs stronger execution safety.

A planned migration must persist the capability assumptions actually used by the strategy. At execution time SPOOL must compare those assumptions with the current connector manifest/version. Missing or semantically incompatible capabilities require re-plan; the runner must not silently choose another mutation strategy.

Examples include:

- transaction boundaries;
- atomic replace behavior;
- upsert/key semantics;
- rollback availability;
- pagination/snapshot guarantees;
- checksum verification support;
- DDL capability.

## Reconciliation 7 — filesystem containment must be symlink-aware and crash-safe

The current Task 4 path check (`resolve(root, resource)` plus prefix comparison) blocks simple `../` traversal but is insufficient by itself against symlink escapes and platform-specific path aliases.

The post-approval filesystem connector design must prove:

- configured root is canonicalized;
- existing source paths are checked through real-path semantics before read;
- target parent directories cannot escape through symlinks;
- absolute paths, drive/UNC edge cases, and case behavior are handled correctly for supported platforms;
- temp files are created inside the authorized target directory;
- write -> flush/fsync as supported -> close -> atomic rename ordering is explicit;
- restart/crash cannot expose a partially committed target as successful;
- verification reopens the committed final target, not the temporary file.

Windows semantics need an explicit test lane if Windows is claimed as supported.

## Reconciliation 8 — SQLite checkpoints must represent committed boundaries only

The execution design already says durable checkpoints advance after target acknowledgement. For SQLite this must be sharpened to transaction ordering:

1. transform/validate bounded batch;
2. open/use target transaction according to approved plan;
3. write batch;
4. commit target transaction;
5. obtain/record durable target evidence;
6. advance SPOOL checkpoint;
7. acknowledge progress to caller.

A checkpoint must never represent rows that were only staged in an uncommitted transaction. Recovery tests must kill/restart around the commit/checkpoint boundary and prove at-most-once/defined replay behavior for the selected write strategy.

## Reconciliation 9 — `COMPLETE` is verification-gated

The implementation plan must keep execution and completion separate. Exhausting source batches or successfully returning from connector `write()` is not sufficient.

The terminal transition is:

`EXECUTING -> VERIFYING -> COMPLETE`

only when the approved verification policy passes. Otherwise the terminal state must preserve explicit verification failure evidence and produce a failure/partial receipt rather than a false success receipt.

## Reconciliation 10 — one mutation authority across CLI/API/MCP/WebMCP

No transport is allowed to call connector mutation methods directly or implement its own job transition logic.

The P1 decomposition must preserve this layering:

`transport/auth/envelope -> command service -> planner/runner -> connector -> job/receipt store`

Transport adapters may perform authentication, request limits, serialization, schema validation, and presentation. They may not become alternate execution engines.

Interface parity must be tested using the same prepared migration through direct command service, CLI, HTTP API, and MCP stdio and comparing plan/job/receipt semantics rather than only exit status.

## Reconciliation 11 — localhost is not automatically trusted

Before `spoold` exposes browser-accessible HTTP, the implementation plan must explicitly test:

- loopback-only bind by default;
- strict Origin validation for browser requests;
- short-lived, single-purpose pairing tokens;
- token replay/expiry behavior;
- DNS rebinding/Host validation defenses;
- CSRF-resistant mutation requests;
- request-size and bounded-preview limits;
- no unauthenticated state mutation;
- no secret-bearing introspection responses;
- no CORS wildcard credential pattern;
- no silent switch from browser-local mode to daemon execution.

The production browser application's existing network-closed dataset boundary must not be weakened globally to enable pairing.

## Reconciliation 12 — receipt integrity must be tied to the terminal job state

A receipt is evidence, not a UI summary. The final P1 receipt schema must bind at minimum:

- immutable plan identity/revision;
- job attempt/lineage;
- redacted source/target identities;
- connector names/versions;
- source snapshot/fingerprint evidence;
- committed checkpoint/transaction evidence;
- processed/accepted/rejected counts;
- verification policy and per-check result;
- approvals/policy decisions;
- terminal status;
- tool/runtime version.

Receipt creation must occur from persisted authoritative job state. A transport must never fabricate or mutate receipt evidence independently.

## Required pre-code edit sequence after explicit written-spec approval

Before implementing Task 1, reconcile the implementation plan itself with the decisions above. The first executable increment should then remain narrowly scoped:

1. typed `spool-plan-v1` identity record;
2. strict canonicalization with explicit rejection behavior;
3. SHA-256 domain-separated plan identity;
4. deep immutability/defensive authority;
5. redacted connector-reference validation sufficient for the plan boundary;
6. focused deterministic/negative tests;
7. existing full browser release gate on the supported browser runtime;
8. Node 24.15+ daemon CI lane before any `node:sqlite` code is accepted.

Do not combine filesystem/SQLite connectors, persistence, HTTP, CLI, MCP, or `spoold` into that first architectural commit.

## Verification evidence at review time

Repository head before this review: `399904d255d057b957b3365d7894f3e7b7f25f4e`.

GitHub currently exposes no combined status entries and no workflow-run evidence for that documentation commit. Therefore this review does not claim CI passed for the current head.

Live production evidence:

- Vercel project: `spool-webmcp`;
- runtime setting: Node 24.x;
- latest deployment: `dpl_5f4BkNzgEqFoVJcsgkw7jRUuWgP9`;
- target: production;
- deployment state: `READY`;
- grouped runtime errors in the previous 24 hours at review time: none found.

This review changes documentation only. No production deployment is warranted.

## Next priority

Until the written architecture spec is explicitly approved in chat, continue only with evidence that reduces implementation risk. The highest-value remaining design item is an exact P1 state/transaction/recovery invariant table covering job transitions, SQLite commit ordering, checkpoint replay, filesystem atomicity, verification failure, cancellation, and process restart. After approval, update the stale implementation plan first, then implement only the immutable plan identity slice and run the complete release gate before progressing.