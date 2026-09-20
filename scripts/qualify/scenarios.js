// Required-scenario manifest for industrial PostgreSQL qualification.
//
// Every entry runs in order; every entry must report. Imports are static on
// purpose: a missing scenario module crashes the harness (exit 2, fatal)
// instead of degrading into a PASS stub. There is no dynamic import, no
// try/catch around scenario loading, and no per-scenario opt-out.
import { runTargetLoad } from './postgres/target-load.js';
import { runBulkLoad } from './postgres/bulk-load.js';
import { runVerificationLoad } from './postgres/verification-load.js';
import { runRepairLoad } from './postgres/repair-load.js';
import { runCdcSoak } from './postgres/cdc-soak.js';
import { runWorkerLoad } from './postgres/worker-load.js';
import { runLargeTransactions } from './postgres/large-transactions.js';
import { runDatabaseSourceLoad } from './postgres/database-source-load.js';
import { runCrashRecovery } from './postgres/crash-recovery.js';

export const REQUIRED_SCENARIOS = Object.freeze([
  Object.freeze({ name: 'postgres.target.load', run: runTargetLoad }),
  Object.freeze({ name: 'postgres.bulk.load', run: runBulkLoad }),
  Object.freeze({ name: 'postgres.content-exact.verification', run: runVerificationLoad }),
  Object.freeze({ name: 'postgres.repair.load', run: runRepairLoad }),
  Object.freeze({ name: 'postgres.cdc.soak', run: runCdcSoak }),
  Object.freeze({ name: 'postgres.workers.load', run: runWorkerLoad }),
  Object.freeze({ name: 'postgres.largeTransactions', run: runLargeTransactions }),
  Object.freeze({ name: 'postgres.database-source.load', run: runDatabaseSourceLoad }),
  Object.freeze({ name: 'postgres.crashRecovery', run: runCrashRecovery })
]);

export function requiredScenarioNames() {
  return Object.freeze(REQUIRED_SCENARIOS.map(entry => entry.name));
}

// Central failure-folding rule shared by the harness: a returned failure is
// unexpected unless it is an explicitly expected refusal. Unexpected folds
// to FAIL; anything else stays PASS. Unit-tested: this predicate is what
// stops returned failures from passing silently.
export function isUnexpectedFailure(failure) {
  return failure?.expected !== true && failure?.classification !== 'EXPECTED_REFUSAL';
}

export function foldScenarioFailures(returnedFailures) {
  const list = Array.isArray(returnedFailures) ? [...returnedFailures] : [];
  const unexpected = list.filter(isUnexpectedFailure);
  return Object.freeze({
    failures: Object.freeze(list),
    unexpected: Object.freeze([...unexpected]),
    status: unexpected.length ? 'FAIL' : 'PASS'
  });
}
