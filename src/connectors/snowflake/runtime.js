import { preflightSnowflakeTarget } from './preflight.js';
import { SnowflakeTarget } from './target.js';
import { verifySnowflakeContent } from './content-verification.js';

export const SNOWFLAKE_TARGET_DESCRIPTOR = Object.freeze({
  connector: 'snowflake',
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

export function createSnowflakeRuntime({ credentialBroker = null, mockClient = null } = {}) {
  return Object.freeze({
    descriptor: SNOWFLAKE_TARGET_DESCRIPTOR,
    assurance: 'C4',
    preflight: async input => await preflightSnowflakeTarget({ ...input, credentialBroker, mockClient }),
    createTarget: opts => new SnowflakeTarget({ ...opts, credentialBroker, mockClient }),
    verifyContent: async input => await verifySnowflakeContent({ ...input, credentialBroker, mockClient })
  });
}
