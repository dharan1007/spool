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
import { runCdcProductionLifecycle } from './postgres/cdc-production-lifecycle.js';
import { runWorkerLoad } from './postgres/worker-load.js';
import { runLargeTransactions } from './postgres/large-transactions.js';
import { runDatabaseSourceLoad } from './postgres/database-source-load.js';
import { runCrashRecovery } from './postgres/crash-recovery.js';

// profileKeys declares which profile fields a scenario must consume EXACTLY.
// The harness compares metrics.effectiveConfig against the profile for every
// listed key; any divergence is PROFILE_DOWNSCALED (FAIL). Silent
// Math.min caps are forbidden: if the environment cannot execute the
// declared workload, the run is ENVIRONMENT_BLOCKED, never a quiet PASS
// under a larger profile name.
export const REQUIRED_SCENARIOS = Object.freeze([
  Object.freeze({ name: 'postgres.target.load', run: runTargetLoad, profileKeys: ['rows', 'batchSize'] }),
  Object.freeze({ name: 'postgres.bulk.load', run: runBulkLoad, profileKeys: ['rows', 'batchSize'] }),
  Object.freeze({ name: 'postgres.content-exact.verification', run: runVerificationLoad, profileKeys: ['rows'] }),
  Object.freeze({ name: 'postgres.repair.load', run: runRepairLoad, profileKeys: ['rows'] }),
  Object.freeze({ name: 'postgres.cdc.soak', run: runCdcSoak, profileKeys: ['cdcDurationSeconds', 'writers'] }),
  Object.freeze({ name: 'postgres.cdc.productionLifecycle', run: runCdcProductionLifecycle, profileKeys: ['rows', 'writers', 'cdcDurationSeconds', 'largeTransactionRows'] }),
  Object.freeze({ name: 'postgres.workers.load', run: runWorkerLoad, profileKeys: ['rows', 'workers'] }),
  Object.freeze({ name: 'postgres.largeTransactions', run: runLargeTransactions, profileKeys: ['largeTransactionRows'] }),
  Object.freeze({ name: 'postgres.database-source.load', run: runDatabaseSourceLoad, profileKeys: ['writers'] }),
  Object.freeze({ name: 'postgres.crashRecovery', run: runCrashRecovery, profileKeys: ['rows'] })
]);

export function requiredScenarioNames() {
  return Object.freeze(REQUIRED_SCENARIOS.map(entry => entry.name));
}

// The same fail-closed expected-refusal predicate is used by the harness
// and by the independent evidence verifier. Do not replicate its logic.
export { isExpectedRefusal, isUnexpectedFailure, foldScenarioFailures, isLogicalWalLevel, scenarioCanPass } from './failure-classification.js';
