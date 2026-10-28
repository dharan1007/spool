import { loadConnectorDriver } from '../driver-loader.js';

// Snowflake is an optional connector: `snowflake-sdk` is not part of the core
// production dependency set, so the driver loads only when no mock client and no
// HTTP wire endpoint is configured.
export function loadSnowflakeDriver() {
  return loadConnectorDriver({
    specifier: 'snowflake-sdk',
    connector: 'snowflake',
    packageName: 'snowflake-sdk',
    installHint: 'install it with "npm install snowflake-sdk@^3.4.0" beside this release (see docs/DEPENDENCY_RISK.md)',
    supportedMajor: 3,
    requiredExports: ['createConnection']
  });
}
