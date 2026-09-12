# SPOOL Verified Mutation Protocol (SVMP) v1

Status: normative protocol contract for the SPOOL verified-mutation kernel.

SVMP defines the correctness boundary for consequential external mutations. UI flows, agents, workflow engines and connector-specific implementations may propose or orchestrate work, but an external effect is considered safe only when it satisfies this protocol and the connector can prove the required semantics.

## Immutable correctness identities

Every verified mutation binds eight independent identities:

- `SourceState`: the exact source state used for planning and execution.
- `Plan`: the deterministic effect plan and transformation semantics.
- `TargetState`: the target contract/state against which execution was authorized.
- `Authority`: the principal, policy decision, limits, scope and expiry permitting the effect.
- `Execution`: the concrete execution attempt and fenced ownership context.
- `Evidence`: durable target-native evidence describing what committed.
- `Verification`: the obligations and results proving the resulting state.
- `Receipt`: the immutable summary binding the preceding identities and release identity.

The canonical identity-set representation is versioned and domain-separated. Reusing an identity with conflicting semantics is an error, never an idempotent replay.

## Canonical state machine

The normal path is:

`DISCOVERED -> SNAPSHOTTED -> PLANNED -> VALIDATED -> AUTHORIZED -> EXECUTING -> RECONCILING -> VERIFYING -> VERIFIED`

SVMP also defines explicit exceptional states:

- `SOURCE_DRIFT`
- `TARGET_DRIFT`
- `AUTHORITY_EXPIRED`
- `LEASE_LOST`
- `COMMIT_UNKNOWN`
- `RECONCILIATION_CONFLICT`
- `VERIFICATION_FAILED`
- `COMPENSATION_REQUIRED`

A generic exception must not be substituted for one of these protocol outcomes when the outcome is knowable.

## Normative semantics

### Authorized

A mutation is authorized only when the exact bound authority remains valid for the current source state, plan, target state, requested effects, limits, principal, policy decision, environment and execution boundary. Authorization of one identity set does not authorize another.

### Committed

A mutation is committed only when durability of the exact external effect is proven by authoritative target-native evidence. A successful client response, absence of an error, or a locally advanced checkpoint is not sufficient proof.

### Idempotent

A mutation is idempotent when replay of the same immutable mutation identity cannot create a second distinct external effect, while reuse of that identity with conflicting semantics fails closed.

### Reconciled

A mutation is reconciled when authoritative target evidence resolves an uncertain execution outcome for the exact mutation identity. Conflicting or insufficient evidence remains unresolved and must not be converted into success by retry policy.

### Verified

A mutation is verified only after every verification obligation bound into the approved plan has completed against the resulting target state and durable evidence, with all required invariants satisfied.

## Required correctness invariants

The bounded executable model in `src/protocol/svmp-model.js` exhaustively explores its finite state space and checks these named invariants on every reachable state:

1. `checkpoint_requires_exact_commit_evidence` — a checkpoint cannot advance unless the exact external commit has authoritative target evidence.
2. `verified_requires_checkpoint_and_evidence` — `VERIFIED` requires a durable checkpoint, exact commit evidence and successful verification.
3. `stale_fence_cannot_mutate` — a worker holding a superseded fencing generation cannot create an external effect after takeover.
4. `mutation_identity_commits_at_most_once` — the same immutable mutation identity cannot create more than one committed effect.
5. `execution_requires_current_authority` — execution cannot create effects after authority, source binding or target binding has become invalid.
6. `drift_cannot_reach_verified` — source or target drift that invalidates the bound mutation cannot silently reach `VERIFIED`.
7. `unknown_commit_requires_reconciliation` — an unknown COMMIT outcome must pass through reconciliation before verification or replay.
8. `conflicting_reconciliation_cannot_advance` — conflicting target evidence cannot advance the checkpoint or reach `VERIFIED`.

## Crash and takeover rules

A process crash does not establish whether a remote transaction committed. If the client cannot prove the outcome, SVMP enters `COMMIT_UNKNOWN`. SPOOL must interrogate authoritative target evidence for the immutable mutation/batch identity before deciding whether to advance or retry.

Lease loss does not imply that the old process stopped. A takeover therefore increments a monotonic fencing generation, and the resource boundary must reject effects from stale generations. Application-clock expiry alone is not a fencing mechanism.

A crash after target commit but before local checkpoint persistence is recovered by reconciliation. Exact target evidence advances the checkpoint without replaying the effect. Missing evidence permits retry only when the connector can prove the original effect did not commit. Conflicting evidence enters `RECONCILIATION_CONFLICT` and fails closed.

## Rollback and compensation

Rollback means the original effect never became durable. Compensation is a later mutation intended to counteract an already durable effect. SVMP never represents compensation as rollback. A required compensating action receives a new plan, authority, execution identity, evidence and receipt.

## Executable model and counterexamples

`src/protocol/svmp-model.js` is a bounded explicit-state model of the correctness kernel, not a claim that the entire application has been formally verified. It explores legal crash, commit-uncertainty, reconciliation, lease-loss, worker-takeover, drift, authority-expiry and verification paths.

The release gate also performs mutation testing of the model. It deliberately enables unsafe transitions such as checkpoint advancement without commit evidence and stale-fence mutation. The checker must reject those mutated models and return a concrete counterexample trace. A checker that cannot detect these injected violations is itself considered invalid.

The executable model supplements connector conformance and fault-injection tests. Connector claims remain limited to the semantics actually enforced at the target boundary.

## Release requirement

A production release is not eligible to pass the SPOOL release gate unless the safe SVMP model has no invariant violations and the unsafe model mutations produce the required counterexamples. This protocol therefore participates directly in release qualification rather than existing only as documentation.
