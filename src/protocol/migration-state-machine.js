import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.js';
import { sha256Canonical, canonicalJson } from '../platform/canonical-json.js';

export const MIGRATION_STATES = Object.freeze({
  CREATED: 'CREATED',
  DISCOVERING: 'DISCOVERING',
  PREFLIGHTED: 'PREFLIGHTED',
  PLANNED: 'PLANNED',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  APPROVED: 'APPROVED',
  SNAPSHOT_ARMED: 'SNAPSHOT_ARMED',
  SNAPSHOT_RUNNING: 'SNAPSHOT_RUNNING',
  FULL_LOAD_RUNNING: 'FULL_LOAD_RUNNING',
  CDC_RUNNING: 'CDC_RUNNING',
  CATCHING_UP: 'CATCHING_UP',
  VERIFYING: 'VERIFYING',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  READY_FOR_CUTOVER: 'READY_FOR_CUTOVER',
  REPAIR_PLANNED: 'REPAIR_PLANNED',
  REPAIR_APPROVED: 'REPAIR_APPROVED',
  REPAIRING: 'REPAIRING',
  REVERIFYING: 'REVERIFYING',
  CUTOVER_ARMED: 'CUTOVER_ARMED',
  FINAL_DRAIN: 'FINAL_DRAIN',
  FINAL_VERIFY: 'FINAL_VERIFY',
  CUTOVER_COMMITTED: 'CUTOVER_COMMITTED',
  POST_CUTOVER_VERIFY: 'POST_CUTOVER_VERIFY',
  COMPLETED: 'COMPLETED',
  FAILED_RECOVERABLE: 'FAILED_RECOVERABLE',
  RECOVERY_PENDING: 'RECOVERY_PENDING',
  FAILED_OPERATOR_REQUIRED: 'FAILED_OPERATOR_REQUIRED',
  ABORTED: 'ABORTED'
});

const ALL_STATES = new Set(Object.values(MIGRATION_STATES));

// Terminal states: no automatic onward progress is possible from these states.
// FAILED_RECOVERABLE is intentionally NOT terminal: it has an explicit
// operator-initiated recovery path (FAILED_RECOVERABLE -> RECOVERY_PENDING).
// ABORTED remains listed as terminal because return to the lifecycle requires
// an explicit rearm operation with a fresh cutover attempt identity; the
// ABORTED -> CUTOVER_ARMED graph edge exists solely for that operation and
// its preconditions reject any implicit traversal.
export const MIGRATION_TERMINAL_STATES = Object.freeze([
  MIGRATION_STATES.COMPLETED,
  MIGRATION_STATES.FAILED_OPERATOR_REQUIRED,
  MIGRATION_STATES.ABORTED
]);

const TERMINAL_SET = new Set(MIGRATION_TERMINAL_STATES);

// Build allowed transitions graph explicitly
const ALLOWED = new Map();
function allow(from, ...to) {
  if (!ALLOWED.has(from)) ALLOWED.set(from, new Set());
  for (const t of to) ALLOWED.get(from).add(t);
}

// Linear happy path
allow(MIGRATION_STATES.CREATED, MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.DISCOVERING, MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.PREFLIGHTED, MIGRATION_STATES.PLANNED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.PLANNED, MIGRATION_STATES.AWAITING_APPROVAL, MIGRATION_STATES.APPROVED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.AWAITING_APPROVAL, MIGRATION_STATES.APPROVED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);

allow(MIGRATION_STATES.APPROVED, MIGRATION_STATES.SNAPSHOT_ARMED, MIGRATION_STATES.SNAPSHOT_RUNNING, MIGRATION_STATES.FULL_LOAD_RUNNING, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.SNAPSHOT_ARMED, MIGRATION_STATES.SNAPSHOT_RUNNING, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.SNAPSHOT_RUNNING, MIGRATION_STATES.FULL_LOAD_RUNNING, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.FULL_LOAD_RUNNING, MIGRATION_STATES.CDC_RUNNING, MIGRATION_STATES.CATCHING_UP, MIGRATION_STATES.VERIFYING, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.CDC_RUNNING, MIGRATION_STATES.CATCHING_UP, MIGRATION_STATES.VERIFYING, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.CATCHING_UP, MIGRATION_STATES.VERIFYING, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.VERIFYING, MIGRATION_STATES.READY_FOR_CUTOVER, MIGRATION_STATES.VERIFICATION_FAILED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.VERIFICATION_FAILED, MIGRATION_STATES.REPAIR_PLANNED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.REPAIR_PLANNED, MIGRATION_STATES.REPAIR_APPROVED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.REPAIR_APPROVED, MIGRATION_STATES.REPAIRING, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.REPAIRING, MIGRATION_STATES.REVERIFYING, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.REVERIFYING, MIGRATION_STATES.READY_FOR_CUTOVER, MIGRATION_STATES.VERIFICATION_FAILED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.ABORTED);
allow(MIGRATION_STATES.READY_FOR_CUTOVER, MIGRATION_STATES.CUTOVER_ARMED, MIGRATION_STATES.ABORTED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED);
allow(MIGRATION_STATES.CUTOVER_ARMED, MIGRATION_STATES.FINAL_DRAIN, MIGRATION_STATES.FINAL_VERIFY, MIGRATION_STATES.ABORTED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED);
// FINAL_DRAIN and FINAL_VERIFY must go through FINAL_VERIFY before commit for correctness.
// There is intentionally NO direct CUTOVER_ARMED -> CUTOVER_COMMITTED edge:
// commit is only reachable from FINAL_VERIFY with a bound finalVerificationId.
allow(MIGRATION_STATES.FINAL_DRAIN, MIGRATION_STATES.FINAL_VERIFY, MIGRATION_STATES.ABORTED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED);
allow(MIGRATION_STATES.FINAL_VERIFY, MIGRATION_STATES.CUTOVER_COMMITTED, MIGRATION_STATES.ABORTED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED);
allow(MIGRATION_STATES.CUTOVER_COMMITTED, MIGRATION_STATES.POST_CUTOVER_VERIFY, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED);
allow(MIGRATION_STATES.POST_CUTOVER_VERIFY, MIGRATION_STATES.COMPLETED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED);

// Re-arm after abort: ABORTED can return to CUTOVER_ARMED ONLY through an explicit
// rearm operation carrying a fresh cutoverAttemptId (see rearm preconditions below).
// There is intentionally NO ABORTED -> READY_FOR_CUTOVER edge: re-arm re-validates
// and arms directly with a new attempt identity.
// FAILED_RECOVERABLE is recoverable through an explicit operator-initiated recovery:
// FAILED_RECOVERABLE -> RECOVERY_PENDING -> safe resume state.
allow(MIGRATION_STATES.ABORTED, MIGRATION_STATES.CUTOVER_ARMED);
allow(MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.RECOVERY_PENDING, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED);
allow(MIGRATION_STATES.RECOVERY_PENDING, MIGRATION_STATES.SNAPSHOT_ARMED, MIGRATION_STATES.FULL_LOAD_RUNNING, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED);

// Ensure every non-terminal has at least FAILED escapes
for (const state of Object.values(MIGRATION_STATES)) {
  if (!ALLOWED.has(state) && !TERMINAL_SET.has(state)) {
    allow(state);
  }
}

const TRANSITION_DOMAIN = 'spool-migration-transition-v1';
const SNAPSHOT_CDC_DOMAIN = 'spool-snapshot-cdc-binding-v1';
const HASH_ID = /^sha256:[a-f0-9]{64}$/;
const LSN = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;
const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SNAPSHOT_TOKEN = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-\d+$/;

function requireMigrationId(value) {
  if (typeof value !== 'string' || !MIGRATION_ID.test(value)) fail('INVALID_MIGRATION_ID', 'Invalid migrationId');
  return value;
}

function requirePrincipal(value) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_PRINCIPAL', 'initiatingPrincipal is required');
  return value.trim();
}

function requireState(value, label) {
  if (typeof value !== 'string' || !ALL_STATES.has(value)) fail('INVALID_MIGRATION_STATE', `${label} must be a known migration state`);
  return value;
}

function requireSequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_TRANSITION_SEQUENCE', 'sequence must be a non-negative safe integer');
  return value;
}

export function isValidMigrationState(state) {
  return typeof state === 'string' && ALL_STATES.has(state);
}

export function isTerminalState(state) {
  requireState(state, 'state');
  return TERMINAL_SET.has(state);
}

export function listAllowedTransitions(from) {
  if (from === null || from === undefined) return Object.freeze([MIGRATION_STATES.CREATED]);
  requireState(from, 'from');
  const set = ALLOWED.get(from);
  if (!set) return Object.freeze([]);
  return Object.freeze([...set].sort());
}

export function isAllowedTransition(from, to) {
  if (from === null || from === undefined) return to === MIGRATION_STATES.CREATED;
  if (!ALL_STATES.has(from) || !ALL_STATES.has(to)) return false;
  return ALLOWED.get(from)?.has(to) ?? false;
}

export function assertAllowedTransition(from, to) {
  if (!isAllowedTransition(from, to)) {
    fail('ILLEGAL_STATE_TRANSITION', `${String(from)} -> ${String(to)} is not allowed by the migration state machine`, {
      from: String(from),
      to: String(to),
      allowed: listAllowedTransitions(from)
    });
  }
  return true;
}

// Transition record identity: deterministic hash of canonical record without transitionId
export function buildTransitionRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_TRANSITION_INPUT', 'Transition input must be an object');

  const migrationId = requireMigrationId(input.migrationId);
  const runId = typeof input.runId === 'string' && input.runId ? input.runId : fail('INVALID_TRANSITION_INPUT', 'runId is required');
  // previousState can be null for CREATED
  const previousState = input.previousState == null ? null : requireState(input.previousState, 'previousState');
  const nextState = requireState(input.nextState, 'nextState');
  // sequence must be provided
  const sequence = requireSequence(input.sequence);
  const principal = requirePrincipal(input.principal ?? input.initiatingPrincipal);
  const reason = typeof input.reason === 'string' ? input.reason.slice(0, 256) : '';
  if (input.reason != null && typeof input.reason !== 'string') fail('INVALID_TRANSITION_INPUT', 'reason must be a string');
  if (reason.length === 0 && input.reason != null && String(input.reason).trim().length === 0) {
    // allow empty but not whitespace-only if provided
  }
  const timestamp = typeof input.timestamp === 'string' && Number.isFinite(Date.parse(input.timestamp)) ? new Date(input.timestamp).toISOString() : new Date().toISOString();

  // Optional binding fields — validated if present
  const planId = input.planId == null ? null : (HASH_ID.test(input.planId) ? input.planId : fail('INVALID_TRANSITION_INPUT', 'planId must be canonical sha256'));
  const sourceStateId = input.sourceStateId == null ? null : (HASH_ID.test(input.sourceStateId) ? input.sourceStateId : fail('INVALID_TRANSITION_INPUT', 'sourceStateId must be canonical sha256'));
  const targetContractId = input.targetContractId == null ? null : (HASH_ID.test(input.targetContractId) ? input.targetContractId : fail('INVALID_TRANSITION_INPUT', 'targetContractId must be canonical sha256'));
  const fenceToken = input.fenceToken == null ? null : (Number.isSafeInteger(input.fenceToken) && input.fenceToken > 0 ? input.fenceToken : fail('INVALID_TRANSITION_INPUT', 'fenceToken must be a positive safe integer'));
  const evidence = input.evidence == null ? null : (() => {
    if (typeof input.evidence !== 'object' || Array.isArray(input.evidence)) fail('INVALID_TRANSITION_INPUT', 'evidence must be a plain object');
    // canonical check will deep-validate
    return JSON.parse(canonicalJson(input.evidence));
  })();

  const record = {
    schemaVersion: 1,
    migrationId,
    runId,
    previousState,
    nextState,
    sequence,
    principal,
    reason,
    timestamp,
    planId,
    sourceStateId,
    targetContractId,
    fenceToken,
    evidence
  };
  // freeze shallow
  return Object.freeze(record);
}

export function createTransitionId(record) {
  // record should be built via buildTransitionRecord without transitionId
  if (!record || typeof record !== 'object') fail('INVALID_TRANSITION_RECORD', 'Transition record is required');
  // ensure record is canonicalizable
  canonicalJson(record);
  return sha256Canonical(TRANSITION_DOMAIN, record);
}

export function createTransition(input) {
  const record = buildTransitionRecord(input);
  const transitionId = createTransitionId(record);
  return Object.freeze({ ...record, transitionId });
}

export function validateTransitionRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_TRANSITION_RECORD', 'Transition record must be an object');
  if (typeof value.transitionId !== 'string' || !HASH_ID.test(value.transitionId)) fail('INVALID_TRANSITION_RECORD', 'transitionId must be canonical sha256');
  const { transitionId, ...rest } = value;
  const rebuilt = buildTransitionRecord(rest);
  const expected = createTransitionId(rebuilt);
  if (expected !== transitionId) fail('TRANSITION_ID_MISMATCH', 'Transition transitionId does not match canonical record hash', {
    expected,
    actual: transitionId
  });
  // also validate timestamp is ISO
  if (!Number.isFinite(Date.parse(value.timestamp))) fail('INVALID_TRANSITION_RECORD', 'timestamp must be ISO date');
  return true;
}

// Precondition checks — these enforce protocol beyond graph edges.
// context may contain: approval, repairApproval, verification, cdcBinding, fencing, plan, sourceState, targetState, cutoverEvidence etc.
// Returns true or throws with specific code.

export function assertTransitionPreconditions({ from, to, context = {} } = {}) {
  assertAllowedTransition(from, to);
  // Terminal guards
  if (from === MIGRATION_STATES.CUTOVER_COMMITTED && to !== MIGRATION_STATES.POST_CUTOVER_VERIFY && to !== MIGRATION_STATES.FAILED_OPERATOR_REQUIRED) {
    fail('ILLEGAL_STATE_TRANSITION', 'No transition from CUTOVER_COMMITTED except to POST_CUTOVER_VERIFY or FAILED_OPERATOR_REQUIRED');
  }
  if (TERMINAL_SET.has(from) && from !== MIGRATION_STATES.ABORTED) {
    // ABORTED has explicit re-arm edges, others are terminal
    fail('ILLEGAL_STATE_TRANSITION', `State ${from} is terminal and cannot transition to ${to}`);
  }
  if (to === MIGRATION_STATES.COMPLETED && from !== MIGRATION_STATES.POST_CUTOVER_VERIFY) {
    fail('ILLEGAL_STATE_TRANSITION', 'COMPLETED is only reachable from POST_CUTOVER_VERIFY');
  }

  // Specific preconditions per target
  switch (to) {
    case MIGRATION_STATES.APPROVED: {
      const approval = context.approval ?? null;
      const planId = context.planId ?? null;
      const sourceStateId = context.sourceStateId ?? null;
      const targetContractId = context.targetContractId ?? null;
      if (!approval || typeof approval !== 'object' || typeof approval.approvalId !== 'string') {
        fail('APPROVAL_REQUIRED', 'APPROVED requires a valid bound approval');
      }
      if (approval.record?.repairPlanIds) {
        fail('REPAIR_APPROVAL_MISUSE', 'Migration approval must never authorize repair');
      }
      // Must bind exact plan/source/target/effects if provided in context
      if (planId && approval.record?.planId !== planId) fail('APPROVAL_BINDING_MISMATCH', 'Approval planId does not match transition planId');
      if (sourceStateId && approval.record?.sourceSnapshotId !== sourceStateId) fail('APPROVAL_BINDING_MISMATCH', 'Approval source binding mismatch');
      if (targetContractId && approval.record?.targetContractId !== targetContractId) fail('APPROVAL_BINDING_MISMATCH', 'Approval target contract mismatch');
      if (approval.record?.expiresAt && Number.isFinite(Date.parse(approval.record.expiresAt)) && Date.parse(approval.record.expiresAt) <= Date.now()) {
        fail('APPROVAL_EXPIRED', 'Approval has expired');
      }
      break;
    }
    case MIGRATION_STATES.CDC_RUNNING:
    case MIGRATION_STATES.CATCHING_UP: {
      const binding = context.cdcBinding ?? context.snapshotCdcBinding ?? null;
      if (!binding) fail('CDC_BINDING_REQUIRED', `${to} requires CDC to be bound to the correct source snapshot/LSN`);
      // binding must have sourceStateId == context.sourceStateId etc.
      if (context.sourceStateId && binding.sourceStateId !== context.sourceStateId) fail('CDC_BINDING_MISMATCH', 'CDC binding sourceStateId mismatch');
      if (!binding.cdcStartLsn || !LSN.test(binding.cdcStartLsn)) fail('CDC_BINDING_REQUIRED', 'CDC binding requires a valid cdcStartLsn');
      if (!binding.snapshotLsn || !LSN.test(binding.snapshotLsn)) fail('CDC_BINDING_REQUIRED', 'CDC binding requires a valid snapshotLsn');
      // snapshot LSN must be <= start LSN (CDC covers after S)
      // We compare by bigint; if start < snapshot, it's an unobserved window
      const toBig = v => { const [hi, lo] = v.split('/'); return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`); };
      if (toBig(binding.cdcStartLsn) < toBig(binding.snapshotLsn)) {
        fail('CDC_GAP', 'CDC start LSN is before snapshot LSN — unobserved window');
      }
      // exported snapshot token if present must be valid
      if (binding.exportedSnapshotId != null && binding.exportedSnapshotId !== '' && !SNAPSHOT_TOKEN.test(binding.exportedSnapshotId)) {
        fail('INVALID_SNAPSHOT_TOKEN', 'exportedSnapshotId is invalid');
      }
      break;
    }
    case MIGRATION_STATES.READY_FOR_CUTOVER: {
      const verification = context.verification ?? null;
      if (!verification || verification.status !== 'VERIFIED') {
        fail('VERIFICATION_REQUIRED', 'READY_FOR_CUTOVER requires successful verification');
      }
      // acceptable CDC lag if CDC present
      if (context.cdcLagMs != null) {
        const maxLag = context.maxCdcLagMs ?? 2000;
        if (Number.isFinite(context.cdcLagMs) && context.cdcLagMs > maxLag) {
          fail('CUTOVER_LAG_EXCEEDED', `CDC lag ${context.cdcLagMs}ms exceeds threshold ${maxLag}ms`);
        }
      }
      break;
    }
    case MIGRATION_STATES.CUTOVER_ARMED: {
      const cutoverEvidence = context.cutoverEvidence ?? context.receipt ?? null;
      const planId = context.planId ?? null;
      const targetContractId = context.targetContractId ?? null;
      // Re-arm after abort is explicit only: ABORTED -> CUTOVER_ARMED through the
      // generic transition path is rejected unless the caller supplies a fresh
      // rearm context (minted by the explicit rearm operation with a new attempt id).
      if (from === MIGRATION_STATES.ABORTED) {
        const rearm = context.rearm ?? null;
        if (!rearm || typeof rearm !== 'object' || Array.isArray(rearm)) {
          fail('CUTOVER_REARM_REQUIRED', 'Re-arming a cutover after abort requires an explicit rearm operation with a fresh cutover attempt identity');
        }
        if (typeof rearm.cutoverAttemptId !== 'string' || !HASH_ID.test(rearm.cutoverAttemptId)) {
          fail('CUTOVER_REARM_REQUIRED', 'Re-arm requires a fresh cutoverAttemptId');
        }
        if (typeof rearm.principal !== 'string' || !rearm.principal.trim()) {
          fail('CUTOVER_REARM_REQUIRED', 'Re-arm requires the re-arming principal');
        }
        if (typeof rearm.reason !== 'string' || !rearm.reason.trim()) {
          fail('CUTOVER_REARM_REQUIRED', 'Re-arm requires a reason');
        }
      }
      // Must be armed with valid receipt / approval showing verified evidence
      if (!cutoverEvidence && !context.approval) {
        fail('CUTOVER_APPROVAL_REQUIRED', 'CUTOVER_ARMED requires a valid cutover approval/receipt with verified evidence');
      }
      if (planId && context.armedPlanId && planId !== context.armedPlanId) fail('CUTOVER_PLAN_CHANGED', 'Plan changed since cutover arming');
      if (targetContractId && context.armedTargetContractId && targetContractId !== context.armedTargetContractId) {
        fail('CUTOVER_CONTRACT_CHANGED', 'Target contract changed since cutover arming');
      }
      // Must have verified verification
      if (context.verification && context.verification.status !== 'VERIFIED') {
        fail('VERIFICATION_REQUIRED', 'Cutover arming requires verified target');
      }
      break;
    }
    case MIGRATION_STATES.CUTOVER_COMMITTED: {
      const fenceToken = context.fenceToken ?? null;
      const finalVerificationId = context.finalVerificationId ?? null;
      if (!fenceToken || !Number.isSafeInteger(fenceToken) || fenceToken <= 0) {
        fail('FENCE_REQUIRED', 'CUTOVER_COMMITTED requires a fresh fence token');
      }
      if (from !== MIGRATION_STATES.FINAL_VERIFY) {
        // No bypass: commit is reachable only from FINAL_VERIFY. The direct
        // CUTOVER_ARMED -> CUTOVER_COMMITTED graph edge was deliberately removed.
        fail('ILLEGAL_STATE_TRANSITION', 'CUTOVER_COMMITTED requires prior FINAL_VERIFY in the same cutover attempt');
      }
      // Identity-bound proof is mandatory. Object presence is never sufficient:
      // the RunStore validates the persisted verification record (existence,
      // mode, status, plan/source/contract bindings, cutover attempt, recency)
      // before this transition is allowed to commit.
      if (typeof finalVerificationId !== 'string' || !HASH_ID.test(finalVerificationId)) {
        fail('VERIFICATION_REQUIRED', 'CUTOVER_COMMITTED requires the exact persisted finalVerificationId of a FINAL_PRE_CUTOVER verification');
      }
      break;
    }
    case MIGRATION_STATES.COMPLETED: {
      const postCutoverVerificationId = context.postCutoverVerificationId ?? null;
      if (typeof postCutoverVerificationId !== 'string' || !HASH_ID.test(postCutoverVerificationId)) {
        fail('VERIFICATION_REQUIRED', 'COMPLETED requires the exact persisted postCutoverVerificationId of a POST_CUTOVER verification');
      }
      break;
    }
    case MIGRATION_STATES.REPAIR_PLANNED:
    case MIGRATION_STATES.REPAIR_APPROVED:
    case MIGRATION_STATES.REPAIRING: {
      // migration approval must never authorize repair
      if (context.approval && !context.repairApproval) {
        // if someone passes a migration approval for repair states, reject
        if (context.approval.record && !context.approval.record.repairPlanIds) {
          // it's a migration approval, not repair approval
          if ([MIGRATION_STATES.REPAIR_PLANNED, MIGRATION_STATES.REPAIR_APPROVED, MIGRATION_STATES.REPAIRING, MIGRATION_STATES.REVERIFYING].includes(to)) {
            fail('REPAIR_APPROVAL_REQUIRED', 'Repair states must use RepairApproval, not migration approval');
          }
        }
      }
      if (to === MIGRATION_STATES.REPAIR_APPROVED && (!context.repairApproval || typeof context.repairApproval.approvalId !== 'string')) {
        fail('REPAIR_APPROVAL_REQUIRED', 'REPAIR_APPROVED requires a valid RepairApproval');
      }
      if (to === MIGRATION_STATES.REPAIRING && (!context.repairApproval || typeof context.repairApproval.approvalId !== 'string')) {
        fail('REPAIR_APPROVAL_REQUIRED', 'REPAIRING requires a valid RepairApproval');
      }
      break;
    }
    case MIGRATION_STATES.FINAL_DRAIN:
    case MIGRATION_STATES.FINAL_VERIFY: {
      // Once cutover committed, these pre-cutover paths must not be re-entered unless explicitly allowed
      if (context.cutoverCommitted === true) {
        fail('CUTOVER_ALREADY_COMMITTED', 'Pre-cutover execution/repair paths are frozen after CUTOVER_COMMITTED');
      }
      // Draining and final verification perform fenced work; the fence that
      // authorizes the attempt must be presented when entering these states.
      if (!Number.isSafeInteger(context.fenceToken) || context.fenceToken <= 0) {
        fail('FENCE_REQUIRED', `${to} requires a fresh fence token`);
      }
      break;
    }
    case MIGRATION_STATES.RECOVERY_PENDING: {
      const recovery = context.recovery ?? null;
      if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) {
        fail('RECOVERY_EVIDENCE_REQUIRED', 'RECOVERY_PENDING requires explicit recovery evidence (targetState, reason, principal)');
      }
      if (![MIGRATION_STATES.SNAPSHOT_ARMED, MIGRATION_STATES.FULL_LOAD_RUNNING].includes(recovery.targetState)) {
        fail('RECOVERY_TARGET_INVALID', 'Recovery target must be a safe resume point (SNAPSHOT_ARMED or FULL_LOAD_RUNNING)', { targetState: recovery.targetState ?? null });
      }
      if (typeof recovery.reason !== 'string' || !recovery.reason.trim()) {
        fail('RECOVERY_EVIDENCE_REQUIRED', 'Recovery requires a non-empty reason describing the resolved failure cause');
      }
      break;
    }
    default:
      break;
  }

  // Cross-cutting: if to is any post-cutover-commit path except via correct sequence, block if cutover already committed
  if (context.cutoverCommitted === true) {
    const allowedAfterCommit = new Set([MIGRATION_STATES.POST_CUTOVER_VERIFY, MIGRATION_STATES.COMPLETED, MIGRATION_STATES.FAILED_RECOVERABLE, MIGRATION_STATES.FAILED_OPERATOR_REQUIRED]);
    if (!allowedAfterCommit.has(to) && from === MIGRATION_STATES.CUTOVER_COMMITTED) {
      // already handled above but ensure
    }
    // Any attempt to re-enter pre-cutover execution after commit must fail
    const preCutover = new Set([
      MIGRATION_STATES.SNAPSHOT_ARMED, MIGRATION_STATES.SNAPSHOT_RUNNING, MIGRATION_STATES.FULL_LOAD_RUNNING,
      MIGRATION_STATES.CDC_RUNNING, MIGRATION_STATES.CATCHING_UP, MIGRATION_STATES.VERIFYING, MIGRATION_STATES.VERIFICATION_FAILED,
      MIGRATION_STATES.REPAIR_PLANNED, MIGRATION_STATES.REPAIR_APPROVED, MIGRATION_STATES.REPAIRING, MIGRATION_STATES.REVERIFYING,
      MIGRATION_STATES.READY_FOR_CUTOVER, MIGRATION_STATES.CUTOVER_ARMED, MIGRATION_STATES.FINAL_DRAIN, MIGRATION_STATES.FINAL_VERIFY
    ]);
    if (preCutover.has(to)) {
      fail('CUTOVER_ALREADY_COMMITTED', 'Pre-cutover states are frozen after CUTOVER_COMMITTED');
    }
  }

  // No stale plan/target contract: if context provides expected vs actual and they differ, reject
  if (context.expectedPlanId && context.actualPlanId && context.expectedPlanId !== context.actualPlanId) {
    fail('PLAN_CHANGED', 'State transition based on a different plan than approved', {
      expectedPlanId: context.expectedPlanId,
      actualPlanId: context.actualPlanId
    });
  }
  if (context.expectedTargetContractId && context.actualTargetContractId && context.expectedTargetContractId !== context.actualTargetContractId) {
    fail('TARGET_DRIFTED', 'State transition based on a different target contract than approved');
  }

  return true;
}

// Snapshot/CDC binding helpers

export function buildSnapshotCdcBinding(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_SNAPSHOT_CDC_BINDING', 'Snapshot/CDC binding must be an object');
  const sourceStateId = typeof input.sourceStateId === 'string' && HASH_ID.test(input.sourceStateId) ? input.sourceStateId : fail('INVALID_SNAPSHOT_CDC_BINDING', 'sourceStateId must be canonical sha256');
  const databaseSnapshotIdentity = typeof input.databaseSnapshotIdentity === 'string' && input.databaseSnapshotIdentity ? input.databaseSnapshotIdentity : fail('INVALID_SNAPSHOT_CDC_BINDING', 'databaseSnapshotIdentity is required');
  const exportedSnapshotId = input.exportedSnapshotId == null || input.exportedSnapshotId === '' ? null : (SNAPSHOT_TOKEN.test(input.exportedSnapshotId) ? input.exportedSnapshotId : fail('INVALID_SNAPSHOT_CDC_BINDING', 'exportedSnapshotId is invalid'));
  const snapshotLsn = typeof input.snapshotLsn === 'string' && LSN.test(input.snapshotLsn) ? input.snapshotLsn.toUpperCase() : fail('INVALID_SNAPSHOT_CDC_BINDING', 'snapshotLsn must be valid LSN');
  const cdcStartLsn = typeof input.cdcStartLsn === 'string' && LSN.test(input.cdcStartLsn) ? input.cdcStartLsn.toUpperCase() : fail('INVALID_SNAPSHOT_CDC_BINDING', 'cdcStartLsn must be valid LSN');
  const receivedLsn = input.receivedLsn == null ? null : (LSN.test(input.receivedLsn) ? input.receivedLsn.toUpperCase() : fail('INVALID_SNAPSHOT_CDC_BINDING', 'receivedLsn invalid'));
  const appliedLsn = input.appliedLsn == null ? null : (LSN.test(input.appliedLsn) ? input.appliedLsn.toUpperCase() : fail('INVALID_SNAPSHOT_CDC_BINDING', 'appliedLsn invalid'));
  const acknowledgedLsn = input.acknowledgedLsn == null ? null : (LSN.test(input.acknowledgedLsn) ? input.acknowledgedLsn.toUpperCase() : fail('INVALID_SNAPSHOT_CDC_BINDING', 'acknowledgedLsn invalid'));
  const cdcSlot = input.cdcSlot == null ? null : (typeof input.cdcSlot === 'string' && /^[a-z0-9_]{1,63}$/.test(input.cdcSlot) ? input.cdcSlot : fail('INVALID_SNAPSHOT_CDC_BINDING', 'cdcSlot invalid'));
  const cdcPublication = input.cdcPublication == null ? null : (typeof input.cdcPublication === 'string' && /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(input.cdcPublication) ? input.cdcPublication : fail('INVALID_SNAPSHOT_CDC_BINDING', 'cdcPublication invalid'));
  const catalogId = input.catalogId == null ? null : (HASH_ID.test(input.catalogId) ? input.catalogId : fail('INVALID_SNAPSHOT_CDC_BINDING', 'catalogId invalid'));

  // Prove no unobserved window: snapshotLsn <= cdcStartLsn
  const toBig = v => { const [hi, lo] = v.split('/'); return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`); };
  if (toBig(cdcStartLsn) < toBig(snapshotLsn)) {
    fail('CDC_GAP', 'CDC start LSN is before snapshot LSN — snapshot and CDC do not overlap without an unobserved window');
  }
  // LSN monotonicity
  if (receivedLsn != null && toBig(receivedLsn) < toBig(cdcStartLsn)) {
    fail('CDC_LSN_MONOTONICITY_VIOLATION', `LSN monotonicity violated: received ${receivedLsn} < start ${cdcStartLsn}`);
  }
  if (appliedLsn != null && receivedLsn != null && toBig(appliedLsn) > toBig(receivedLsn)) {
    fail('CDC_LSN_MONOTONICITY_VIOLATION', `LSN monotonicity violated: applied ${appliedLsn} > received ${receivedLsn}`);
  }
  if (acknowledgedLsn != null && appliedLsn != null && toBig(acknowledgedLsn) > toBig(appliedLsn)) {
    fail('CDC_ACK_BEYOND_APPLIED', 'CDC acknowledgement advanced beyond durably applied progress');
  }
  if (acknowledgedLsn != null && receivedLsn != null && toBig(acknowledgedLsn) > toBig(receivedLsn)) {
    fail('CDC_ACK_BEYOND_APPLIED', 'CDC acknowledgement advanced beyond received progress');
  }

  const record = {
    schemaVersion: 1,
    sourceStateId,
    databaseSnapshotIdentity,
    exportedSnapshotId,
    snapshotLsn,
    cdcSlot,
    cdcPublication,
    cdcStartLsn,
    receivedLsn,
    appliedLsn,
    acknowledgedLsn,
    catalogId
  };
  canonicalJson(record);
  return Object.freeze(record);
}

export function snapshotCdcBindingId(binding) {
  // deterministic identity for binding
  return sha256Canonical(SNAPSHOT_CDC_DOMAIN, binding);
}

const CUTOVER_ATTEMPT_DOMAIN = 'spool-cutover-attempt-v1';

// Cutover attempt identity: deterministic over the arming inputs so that a
// retried arming (same receipt, same plan/source/contract, same armedAt)
// yields the same attempt id (idempotent re-arm recognition), while any new
// arming after abort carries a new armedAt and therefore a new attempt id.
// The attempt id binds every later cutover-phase transition and verification
// of that attempt, so evidence from a superseded attempt can never authorize
// the current one.
export function buildCutoverAttemptId(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_CUTOVER_ATTEMPT', 'Cutover attempt input must be an object');
  const migrationId = requireMigrationId(input.migrationId);
  const receiptId = typeof input.receiptId === 'string' && input.receiptId ? input.receiptId : fail('INVALID_CUTOVER_ATTEMPT', 'receiptId is required');
  const receiptKind = input.receiptKind === 'migration' || input.receiptKind === 'repair' ? input.receiptKind : fail('INVALID_CUTOVER_ATTEMPT', 'receiptKind must be migration or repair');
  const planId = typeof input.planId === 'string' && HASH_ID.test(input.planId) ? input.planId : fail('INVALID_CUTOVER_ATTEMPT', 'planId must be canonical sha256');
  const sourceStateId = typeof input.sourceStateId === 'string' && HASH_ID.test(input.sourceStateId) ? input.sourceStateId : fail('INVALID_CUTOVER_ATTEMPT', 'sourceStateId must be canonical sha256');
  const targetContractId = typeof input.targetContractId === 'string' && HASH_ID.test(input.targetContractId) ? input.targetContractId : fail('INVALID_CUTOVER_ATTEMPT', 'targetContractId must be canonical sha256');
  const armedAt = typeof input.armedAt === 'string' && Number.isFinite(Date.parse(input.armedAt)) ? new Date(input.armedAt).toISOString() : fail('INVALID_CUTOVER_ATTEMPT', 'armedAt must be an ISO timestamp');
  return sha256Canonical(CUTOVER_ATTEMPT_DOMAIN, {
    migrationId, receiptId, receiptKind, planId, sourceStateId, targetContractId, armedAt
  });
}

export function requireCutoverAttemptId(value) {
  if (typeof value !== 'string' || !HASH_ID.test(value)) fail('INVALID_CUTOVER_ATTEMPT', 'cutoverAttemptId must be a canonical sha256 identity');
  return value;
}

export function validateSnapshotCdcBinding(value) {
  if (!value || typeof value !== 'object') fail('INVALID_SNAPSHOT_CDC_BINDING', 'Snapshot/CDC binding is required');
  // rebuild to validate
  buildSnapshotCdcBinding(value);
  return true;
}

// Recovery decision helper — deterministic whether to resume, reconcile, wait or refuse
export function decideRecoveryAction({ currentState, lastTransition, snapshotCdcBinding, checkpoint, verification, cutover }) {
  // Returns one of: RESUME, RECONCILE, WAIT_OPERATOR, REFUSE
  if (!currentState) return 'REFUSE';
  if ([MIGRATION_STATES.FAILED_OPERATOR_REQUIRED, MIGRATION_STATES.FAILED_RECOVERABLE].includes(currentState)) return 'WAIT_OPERATOR';
  if (currentState === MIGRATION_STATES.RECOVERY_PENDING) return 'RECONCILE';
  if (currentState === MIGRATION_STATES.CUTOVER_COMMITTED) return 'RECONCILE'; // ensure post-cutover verify
  if (currentState === MIGRATION_STATES.COMPLETED || currentState === MIGRATION_STATES.ABORTED) return 'REFUSE';
  // If during execution, need to reconcile before resume
  if ([MIGRATION_STATES.FULL_LOAD_RUNNING, MIGRATION_STATES.SNAPSHOT_RUNNING, MIGRATION_STATES.CDC_RUNNING, MIGRATION_STATES.CATCHING_UP].includes(currentState)) {
    return checkpoint ? 'RECONCILE' : 'RESUME';
  }
  if (currentState === MIGRATION_STATES.VERIFYING || currentState === MIGRATION_STATES.REVERIFYING || currentState === MIGRATION_STATES.FINAL_VERIFY || currentState === MIGRATION_STATES.POST_CUTOVER_VERIFY) {
    return 'RECONCILE';
  }
  return 'RESUME';
}
