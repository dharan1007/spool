export { normalizeSnowflakeRef, withSnowflakeClient, quoteIdentifier } from './connection.js';
export { preflightSnowflakeTarget, snowflakeTargetContractId } from './preflight.js';
export { SnowflakeTarget, snowflakePayloadEvidence, ensureSnowflakeMetadata } from './target.js';
export { verifySnowflakeContent } from './content-verification.js';
export { createSnowflakeRuntime, SNOWFLAKE_TARGET_DESCRIPTOR } from './runtime.js';
