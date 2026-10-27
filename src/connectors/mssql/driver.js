import { loadConnectorDriver } from '../driver-loader.js';

// SQL Server is an optional connector: `mssql` is not part of the core
// production dependency set, so the driver loads on first use only.
export function loadMssqlDriver() {
  return loadConnectorDriver({
    specifier: 'mssql',
    connector: 'mssql',
    packageName: 'mssql',
    installHint: 'install it with "npm install mssql@^12.7.2" beside this release (see docs/DEPENDENCY_RISK.md)',
    supportedMajor: 12,
    requiredExports: ['ConnectionPool', 'Transaction', 'Request', 'ISOLATION_LEVEL']
  });
}
