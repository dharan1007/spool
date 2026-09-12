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
  'conflicting_reconciliation_cannot_advance'
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

console.log(JSON.stringify({
  ok: true,
  protocol: 'SVMP',
  version: 1,
  statesExplored: safe.statesExplored,
  actionsExplored: safe.actionsExplored,
  invariantsProved: safe.invariantsProved,
  mutationTests: {
    checkpointWithoutEvidence: 'counterexample detected',
    staleFenceWrite: 'counterexample detected'
  }
}, null, 2));
