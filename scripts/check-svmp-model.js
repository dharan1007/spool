import { checkSvmpExecutionModel, UNSAFE_MODEL_MUTATIONS } from '../src/protocol/svmp-model.js';

function fail(message, report = null) {
  console.error(`[SVMP MODEL] ${message}`);
  if (report) console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

const safe = checkSvmpExecutionModel();
if (!safe.ok) {
  fail('safe protocol model contains invariant violations', safe);
}
if (safe.statesExplored < 100) {
  fail(`state-space coverage regressed to ${safe.statesExplored} reachable states`, safe);
}

const requiredInvariants = [
  'checkpoint_requires_exact_commit_evidence',
  'verified_requires_checkpoint_and_evidence',
  'stale_fence_cannot_mutate',
  'mutation_identity_commits_at_most_once',
  'execution_requires_current_authority',
  'drift_cannot_reach_verified',
  'unknown_commit_requires_reconciliation',
  'conflicting_reconciliation_cannot_advance',
  'cutover_requires_verified_evidence',
  'no_repair_with_migration_approval',
  'no_two_committed_owners',
  'cdc_ack_not_beyond_applied',
  'no_plan_drift',
  'no_backwards_after_cutover',
  'no_completed_after_failed',
  'cutover_committed_requires_final_verify'
];
const proved = new Set(safe.invariantsProved);
for (const invariant of requiredInvariants) {
  if (!proved.has(invariant)) fail(`safe model did not prove ${invariant}`, safe);
}

const checkpointMutation = checkSvmpExecutionModel({
  mutation: UNSAFE_MODEL_MUTATIONS.ALLOW_CHECKPOINT_WITHOUT_EVIDENCE
});
if (checkpointMutation.ok ||
    !checkpointMutation.violations.some(item => item.invariant === 'checkpoint_requires_exact_commit_evidence')) {
  fail('mutation test failed to detect checkpoint advancement without exact commit evidence', checkpointMutation);
}
if (!checkpointMutation.violations.some(item => Array.isArray(item.trace) && item.trace.length > 0)) {
  fail('checkpoint mutation failure did not produce a counterexample trace', checkpointMutation);
}

const staleFenceMutation = checkSvmpExecutionModel({
  mutation: UNSAFE_MODEL_MUTATIONS.ALLOW_STALE_FENCE_WRITE
});
if (staleFenceMutation.ok ||
    !staleFenceMutation.violations.some(item =>
      item.invariant === 'stale_fence_cannot_mutate' ||
      item.invariant === 'mutation_identity_commits_at_most_once')) {
  fail('mutation test failed to detect a stale-fence external write', staleFenceMutation);
}
if (!staleFenceMutation.violations.some(item => Array.isArray(item.trace) && item.trace.length > 0)) {
  fail('stale-fence mutation failure did not produce a counterexample trace', staleFenceMutation);
}

const cutoverMutation = checkSvmpExecutionModel({
  mutation: UNSAFE_MODEL_MUTATIONS.ALLOW_CUTOVER_WITHOUT_VERIFICATION
});
if (cutoverMutation.ok ||
    !cutoverMutation.violations.some(item => item.invariant === 'cutover_requires_verified_evidence')) {
  fail('mutation test failed to detect cutover arming without verification', cutoverMutation);
}
if (!cutoverMutation.violations.some(item => Array.isArray(item.trace) && item.trace.length > 0)) {
  fail('cutover mutation failure did not produce a counterexample trace', cutoverMutation);
}

const repairMutation = checkSvmpExecutionModel({ mutation: UNSAFE_MODEL_MUTATIONS.ALLOW_REPAIR_WITH_MIGRATION_APPROVAL });
if (repairMutation.ok || !repairMutation.violations.some(item => item.invariant === 'no_repair_with_migration_approval')) {
  fail('mutation test failed to detect repair with migration approval', repairMutation);
}
const secondOwnerMutation = checkSvmpExecutionModel({ mutation: UNSAFE_MODEL_MUTATIONS.ALLOW_SECOND_COMMITTED_OWNER });
if (secondOwnerMutation.ok || !secondOwnerMutation.violations.some(item => item.invariant === 'no_two_committed_owners')) {
  fail('mutation test failed to detect second committed owner', secondOwnerMutation);
}
const cdcAckMutation = checkSvmpExecutionModel({ mutation: UNSAFE_MODEL_MUTATIONS.ALLOW_CDC_ACK_BEYOND_APPLIED });
if (cdcAckMutation.ok || !cdcAckMutation.violations.some(item => item.invariant === 'cdc_ack_not_beyond_applied')) {
  fail('mutation test failed to detect CDC ack beyond applied', cdcAckMutation);
}
const planDriftMutation = checkSvmpExecutionModel({ mutation: UNSAFE_MODEL_MUTATIONS.ALLOW_PLAN_DRIFT });
if (planDriftMutation.ok || !planDriftMutation.violations.some(item => item.invariant === 'no_plan_drift')) {
  fail('mutation test failed to detect plan drift', planDriftMutation);
}
const backwardsMutation = checkSvmpExecutionModel({ mutation: UNSAFE_MODEL_MUTATIONS.ALLOW_BACKWARDS_AFTER_CUTOVER });
if (backwardsMutation.ok || !backwardsMutation.violations.some(item => item.invariant === 'no_backwards_after_cutover')) {
  fail('mutation test failed to detect backwards after cutover', backwardsMutation);
}
const completedAfterFailedMutation = checkSvmpExecutionModel({ mutation: UNSAFE_MODEL_MUTATIONS.ALLOW_COMPLETED_AFTER_FAILED });
if (completedAfterFailedMutation.ok || !completedAfterFailedMutation.violations.some(item => item.invariant === 'no_completed_after_failed')) {
  fail('mutation test failed to detect completed after failed verification', completedAfterFailedMutation);
}
const noFinalVerifyMutation = checkSvmpExecutionModel({ mutation: UNSAFE_MODEL_MUTATIONS.ALLOW_CUTOVER_WITHOUT_FINAL_VERIFY });
if (noFinalVerifyMutation.ok || !noFinalVerifyMutation.violations.some(item => item.invariant === 'cutover_committed_requires_final_verify')) {
  fail('mutation test failed to detect cutover commit without a prior FINAL_VERIFY in the same attempt', noFinalVerifyMutation);
}
if (!noFinalVerifyMutation.violations.some(item => Array.isArray(item.trace) && item.trace.length > 0)) {
  fail('cutover-without-final-verify mutation failure did not produce a counterexample trace', noFinalVerifyMutation);
}

console.log(JSON.stringify({
  ok: true,
  protocol: 'SVMP',
  version: 1,
  statesExplored: safe.statesExplored,
  actionsExplored: safe.actionsExplored,
  invariantsProved: safe.invariantsProved,
  mutationTests: {
    checkpointWithoutEvidence: 'counterexample detected',
    staleFenceWrite: 'counterexample detected',
    cutoverWithoutVerification: 'counterexample detected',
    repairWithMigrationApproval: 'counterexample detected',
    secondOwner: 'counterexample detected',
    cdcAckBeyond: 'counterexample detected',
    planDrift: 'counterexample detected',
    backwardsAfterCutover: 'counterexample detected',
    completedAfterFailed: 'counterexample detected',
    cutoverWithoutFinalVerify: 'counterexample detected'
  }
}, null, 2));
