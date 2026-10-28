import { preflightBigQueryTarget } from './preflight.js';
import { BigQueryTarget } from './target.js';
import { verifyBigQueryContent } from './content-verification.js';

export const BIGQUERY_TARGET_DESCRIPTOR = Object.freeze({
  connector: 'bigquery',
  assurance: 'C4',
  capabilities: Object.freeze([
    'transactions',
    'atomicBatchLedger',
    'reconcileAfterCrash',
    'idempotentReplay',
    'fencing',
    'targetContractBinding',
    'exactCommitEvidence',
    'readAfterWriteVerification'
  ])
});

export function createBigQueryRuntime({ credentialBroker = null, mockClient = null } = {}) {
  return Object.freeze({
    descriptor: BIGQUERY_TARGET_DESCRIPTOR,
    assurance: 'C4',
    preflight: async input => await preflightBigQueryTarget({ ...input, credentialBroker, mockClient }),
    createTarget: opts => new BigQueryTarget({ ...opts, credentialBroker, mockClient }),
    verifyContent: async input => await verifyBigQueryContent({ ...input, credentialBroker, mockClient })
  });
}
