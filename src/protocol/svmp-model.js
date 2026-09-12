import { SVMP_STATES } from './svmp.js';

export const UNSAFE_MODEL_MUTATIONS = Object.freeze({
  ALLOW_CHECKPOINT_WITHOUT_EVIDENCE: 'ALLOW_CHECKPOINT_WITHOUT_EVIDENCE',
  ALLOW_STALE_FENCE_WRITE: 'ALLOW_STALE_FENCE_WRITE'
});

const INVARIANTS = Object.freeze({
  checkpoint_requires_exact_commit_evidence(state) {
    return !state.checkpointAdvanced || (
      state.targetCommitted
      && state.evidencePresent
      && state.reconciliationOutcome === 'COMMITTED'
    );
  },
  verified_requires_checkpoint_and_evidence(state) {
    return state.phase !== SVMP_STATES.VERIFIED || (
      state.verified
      && state.checkpointAdvanced
      && state.targetCommitted
      && state.evidencePresent
      && state.reconciliationOutcome === 'COMMITTED'
    );
  },
  stale_fence_cannot_mutate(state) {
    return state.staleWriteSucceeded !== true;
  },
  mutation_identity_commits_at_most_once(state) {
    return state.commitCount <= 1;
  },
  execution_requires_current_authority(state) {
    return state.phase !== SVMP_STATES.EXECUTING || (
      state.authorityValid
      && state.sourceStable
      && state.targetStable
    );
  },
  drift_cannot_reach_verified(state) {
    return !(state.driftObserved && state.phase === SVMP_STATES.VERIFIED);
  },
  unknown_commit_requires_reconciliation(state) {
    if (!state.unknownCommitObserved) return true;
    if (![SVMP_STATES.VERIFYING, SVMP_STATES.VERIFIED].includes(state.phase)) return true;
    return state.reconciledAfterUnknown && state.reconciliationOutcome === 'COMMITTED';
  },
  conflicting_reconciliation_cannot_advance(state) {
    return !state.reconciliationConflictObserved || (
      !state.checkpointAdvanced
      && !state.verified
      && state.phase === SVMP_STATES.RECONCILIATION_CONFLICT
    );
  }
});

const INVARIANT_NAMES = Object.freeze(Object.keys(INVARIANTS));
const MAX_FENCE = 3;
const MAX_LEASE_RENEWALS = 3;
const MAX_RECONCILIATION_PROBES = 3;

function initialState() {
  return {
    phase: SVMP_STATES.DISCOVERED,
    sourceStable: true,
    targetStable: true,
    driftObserved: false,
    authorityValid: false,
    leaseHeld: false,
    currentFence: 0,
    workerFence: 0,
    staleWorkerFence: null,
    leaseRenewals: 0,
    targetCommitted: false,
    evidencePresent: false,
    commitCount: 0,
    checkpointAdvanced: false,
    unknownCommitObserved: false,
    reconciledAfterUnknown: false,
    reconciliationOutcome: 'NONE',
    reconciliationConflictObserved: false,
    reconciliationProbes: 0,
    staleWriteAttempted: false,
    staleWriteSucceeded: false,
    verificationFailed: false,
    verified: false,
    crashed: false
  };
}

function next(state, patch) {
  return { ...state, ...patch };
}

function activeMutationBoundary(state) {
  return state.authorityValid
    && state.sourceStable
    && state.targetStable
    && state.leaseHeld
    && state.workerFence > 0
    && state.workerFence === state.currentFence;
}

function actionsFor(state, mutation) {
  const actions = [];
  const add = (name, condition, apply) => {
    if (condition) actions.push({ name, state: apply() });
  };

  add('snapshot', state.phase === SVMP_STATES.DISCOVERED, () => next(state, { phase: SVMP_STATES.SNAPSHOTTED }));
  add('plan', state.phase === SVMP_STATES.SNAPSHOTTED, () => next(state, { phase: SVMP_STATES.PLANNED }));
  add('validate', state.phase === SVMP_STATES.PLANNED, () => next(state, { phase: SVMP_STATES.VALIDATED }));
  add('authorize', state.phase === SVMP_STATES.VALIDATED && state.sourceStable && state.targetStable, () => next(state, {
    phase: SVMP_STATES.AUTHORIZED,
    authorityValid: true
  }));
  add('start_execution', state.phase === SVMP_STATES.AUTHORIZED && state.authorityValid && state.sourceStable && state.targetStable, () => {
    const fence = Math.max(1, state.currentFence + 1);
    return next(state, {
      phase: SVMP_STATES.EXECUTING,
      leaseHeld: true,
      currentFence: fence,
      workerFence: fence,
      leaseRenewals: 0
    });
  });

  add('lease_renew',
    [SVMP_STATES.EXECUTING, SVMP_STATES.COMMIT_UNKNOWN, SVMP_STATES.RECONCILING].includes(state.phase)
      && state.leaseHeld
      && state.workerFence === state.currentFence
      && state.leaseRenewals < MAX_LEASE_RENEWALS,
    () => next(state, { leaseRenewals: state.leaseRenewals + 1 }));

  add('target_commit',
    state.phase === SVMP_STATES.EXECUTING && activeMutationBoundary(state) && !state.targetCommitted,
    () => next(state, {
      targetCommitted: true,
      evidencePresent: true,
      commitCount: state.commitCount + 1
    }));

  add('enter_reconciling',
    state.phase === SVMP_STATES.EXECUTING && state.targetCommitted && state.evidencePresent,
    () => next(state, {
      phase: SVMP_STATES.RECONCILING,
      reconciliationOutcome: 'COMMITTED'
    }));

  add('crash_after_commit',
    state.phase === SVMP_STATES.EXECUTING && state.targetCommitted && state.evidencePresent && !state.checkpointAdvanced,
    () => next(state, {
      phase: SVMP_STATES.COMMIT_UNKNOWN,
      unknownCommitObserved: true,
      crashed: true,
      leaseHeld: false,
      staleWorkerFence: state.workerFence,
      workerFence: 0,
      leaseRenewals: 0,
      reconciliationOutcome: 'UNKNOWN'
    }));

  add('lease_lost',
    state.phase === SVMP_STATES.EXECUTING && state.leaseHeld,
    () => next(state, {
      phase: SVMP_STATES.LEASE_LOST,
      leaseHeld: false,
      staleWorkerFence: state.workerFence,
      workerFence: 0
    }));

  add('worker_takeover',
    state.phase === SVMP_STATES.COMMIT_UNKNOWN && !state.leaseHeld && state.currentFence < MAX_FENCE,
    () => {
      const fence = state.currentFence + 1;
      return next(state, {
        leaseHeld: true,
        currentFence: fence,
        workerFence: fence,
        leaseRenewals: 0
      });
    });

  add('lease_lost_during_recovery',
    state.phase === SVMP_STATES.COMMIT_UNKNOWN && state.leaseHeld && state.currentFence < MAX_FENCE,
    () => next(state, {
      leaseHeld: false,
      staleWorkerFence: state.workerFence,
      workerFence: 0,
      leaseRenewals: 0
    }));

  add('reconciliation_probe',
    state.phase === SVMP_STATES.COMMIT_UNKNOWN && state.reconciliationProbes < MAX_RECONCILIATION_PROBES,
    () => next(state, { reconciliationProbes: state.reconciliationProbes + 1 }));

  add('stale_worker_write_attempt',
    [SVMP_STATES.COMMIT_UNKNOWN, SVMP_STATES.RECONCILING].includes(state.phase)
      && state.staleWorkerFence !== null
      && state.currentFence > state.staleWorkerFence
      && !state.staleWriteAttempted,
    () => mutation === UNSAFE_MODEL_MUTATIONS.ALLOW_STALE_FENCE_WRITE
      ? next(state, {
          staleWriteAttempted: true,
          staleWriteSucceeded: true,
          commitCount: state.commitCount + 1
        })
      : next(state, {
          staleWriteAttempted: true,
          staleWriteSucceeded: false
        }));

  add('reconcile_committed',
    state.phase === SVMP_STATES.COMMIT_UNKNOWN && state.targetCommitted && state.evidencePresent,
    () => next(state, {
      phase: SVMP_STATES.RECONCILING,
      reconciledAfterUnknown: true,
      reconciliationOutcome: 'COMMITTED'
    }));

  add('reconciliation_conflict',
    [SVMP_STATES.COMMIT_UNKNOWN, SVMP_STATES.RECONCILING].includes(state.phase) && !state.checkpointAdvanced,
    () => next(state, {
      phase: SVMP_STATES.RECONCILIATION_CONFLICT,
      reconciliationConflictObserved: true,
      leaseHeld: false
    }));

  add('checkpoint_advance',
    state.phase === SVMP_STATES.RECONCILING
      && !state.checkpointAdvanced
      && state.targetCommitted
      && state.evidencePresent
      && state.reconciliationOutcome === 'COMMITTED',
    () => next(state, { checkpointAdvanced: true }));

  add('unsafe_checkpoint_advance',
    mutation === UNSAFE_MODEL_MUTATIONS.ALLOW_CHECKPOINT_WITHOUT_EVIDENCE
      && state.phase === SVMP_STATES.EXECUTING
      && !state.targetCommitted
      && !state.checkpointAdvanced,
    () => next(state, {
      phase: SVMP_STATES.RECONCILING,
      checkpointAdvanced: true,
      reconciliationOutcome: 'COMMITTED'
    }));

  add('start_verification',
    state.phase === SVMP_STATES.RECONCILING
      && state.checkpointAdvanced
      && state.targetCommitted
      && state.evidencePresent
      && state.reconciliationOutcome === 'COMMITTED',
    () => next(state, { phase: SVMP_STATES.VERIFYING }));

  add('verify_success',
    state.phase === SVMP_STATES.VERIFYING && !state.verificationFailed,
    () => next(state, { phase: SVMP_STATES.VERIFIED, verified: true, leaseHeld: false }));

  add('verification_failure',
    state.phase === SVMP_STATES.VERIFYING,
    () => next(state, {
      phase: SVMP_STATES.VERIFICATION_FAILED,
      verificationFailed: true,
      leaseHeld: false
    }));

  const sourceDriftPhase = [
    SVMP_STATES.SNAPSHOTTED,
    SVMP_STATES.PLANNED,
    SVMP_STATES.VALIDATED,
    SVMP_STATES.AUTHORIZED,
    SVMP_STATES.EXECUTING,
    SVMP_STATES.RECONCILING
  ].includes(state.phase);
  add('source_drift', sourceDriftPhase && state.sourceStable, () => next(state, {
    phase: SVMP_STATES.SOURCE_DRIFT,
    sourceStable: false,
    driftObserved: true,
    authorityValid: false,
    leaseHeld: false
  }));

  const targetDriftPhase = [
    SVMP_STATES.PLANNED,
    SVMP_STATES.VALIDATED,
    SVMP_STATES.AUTHORIZED,
    SVMP_STATES.EXECUTING,
    SVMP_STATES.RECONCILING
  ].includes(state.phase);
  add('target_drift', targetDriftPhase && state.targetStable, () => next(state, {
    phase: SVMP_STATES.TARGET_DRIFT,
    targetStable: false,
    driftObserved: true,
    authorityValid: false,
    leaseHeld: false
  }));

  add('authority_expired',
    [SVMP_STATES.AUTHORIZED, SVMP_STATES.EXECUTING, SVMP_STATES.RECONCILING].includes(state.phase) && state.authorityValid,
    () => next(state, {
      phase: SVMP_STATES.AUTHORITY_EXPIRED,
      authorityValid: false,
      leaseHeld: false
    }));

  return actions;
}

function stateKey(state) {
  return JSON.stringify(state);
}

function invariantViolations(state) {
  const violations = [];
  for (const [name, check] of Object.entries(INVARIANTS)) {
    if (!check(state)) violations.push(name);
  }
  return violations;
}

export function checkSvmpExecutionModel({ mutation = null } = {}) {
  if (mutation !== null && !Object.values(UNSAFE_MODEL_MUTATIONS).includes(mutation)) {
    throw new TypeError(`Unknown SVMP model mutation: ${mutation}`);
  }

  const root = initialState();
  const queue = [{ state: root, trace: [] }];
  const visited = new Set([stateKey(root)]);
  const actionsExplored = new Set();
  const firstViolationByInvariant = new Map();
  const reachablePhases = new Set([root.phase]);
  const maxStates = 50_000;

  while (queue.length > 0) {
    const current = queue.shift();
    const violations = invariantViolations(current.state);
    for (const invariant of violations) {
      if (!firstViolationByInvariant.has(invariant)) {
        firstViolationByInvariant.set(invariant, Object.freeze({
          invariant,
          state: Object.freeze({ ...current.state }),
          trace: Object.freeze([...current.trace])
        }));
      }
    }

    for (const action of actionsFor(current.state, mutation)) {
      actionsExplored.add(action.name);
      reachablePhases.add(action.state.phase);
      const key = stateKey(action.state);
      if (visited.has(key)) continue;
      if (visited.size >= maxStates) {
        throw new Error(`SVMP model exceeded bounded state budget of ${maxStates}; refine the model before increasing the bound`);
      }
      visited.add(key);
      queue.push({
        state: action.state,
        trace: [...current.trace, action.name]
      });
    }
  }

  const violations = [...firstViolationByInvariant.values()];
  const violated = new Set(violations.map(item => item.invariant));
  return Object.freeze({
    schemaVersion: 1,
    model: 'SVMP bounded external-mutation model',
    mutation,
    ok: violations.length === 0,
    statesExplored: visited.size,
    actionsExplored: Object.freeze([...actionsExplored].sort()),
    reachablePhases: Object.freeze([...reachablePhases].sort()),
    invariantsProved: Object.freeze(INVARIANT_NAMES.filter(name => !violated.has(name))),
    violations: Object.freeze(violations)
  });
}
