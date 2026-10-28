// The advisory scoped out of the core install (GHSA-xcx6-jx8p-x3h5) lives in an
// authentication flow SPOOL must never invoke. These tests pin the actual
// credential surface of the two connectors that load an affected driver, so a
// future change cannot quietly start forwarding Azure/OAuth credentials into it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mssqlConnectionConfig, parseMssqlEndpoint } from '../src/connectors/mssql/connection.js';
import { normalizeSnowflakeRef, snowflakeSdkOptions } from '../src/connectors/snowflake/connection.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const AZURE_CREDENTIAL_SURFACE = /\b(InteractiveBrowserCredential|AuthorizationCodeCredential|DeviceCodeCredential|DefaultAzureCredential|ClientSecretCredential|UsernamePasswordCredential|ManagedIdentityCredential|OnBehalfOfCredential|@azure\/identity)\b/;

test('SQL Server configuration carries SQL credentials only', () => {
  const config = mssqlConnectionConfig(
    {
      endpoint: 'mssql://sql.example.test:1433/?sslmode=verify-full',
      database: 'app',
      identity: { user: 'spool_runner', clientId: 'ignored', clientSecret: 'ignored', tenantId: 'ignored' }
    },
    'not-a-real-password'
  );

  assert.deepEqual(Object.keys(config).sort(), ['database', 'options', 'password', 'pool', 'port', 'server', 'user']);
  assert.deepEqual(Object.keys(config.options).sort(), ['appName', 'connectTimeout', 'encrypt', 'requestTimeout', 'trustServerCertificate']);
  assert.equal(config.user, 'spool_runner');
  assert.equal(config.options.encrypt, true);
  assert.equal(config.options.trustServerCertificate, false);
  assert.equal('authentication' in config, false);
  assert.equal('azure' in config.options, false);

  // An Azure AD authenticator cannot be smuggled through the endpoint query.
  assert.throws(
    () => parseMssqlEndpoint('mssql://sql.example.test/?authentication=azure-active-directory'),
    error => error.code === 'INVALID_MSSQL_ENDPOINT'
  );
  assert.throws(
    () => parseMssqlEndpoint('mssql://sql.example.test/?authentication=azure-active-directory&sslmode=require'),
    error => error.code === 'INVALID_MSSQL_ENDPOINT'
  );
});

test('Snowflake SDK options never forward an authenticator, token or Azure credential', () => {
  const injected = {
    account: 'acct',
    database: 'db',
    schema: 'public',
    table: 't',
    warehouse: 'wh',
    role: 'r',
    authenticator: 'EXTERNALBROWSER',
    token: 'injected-token',
    password: 'injected-password',
    privateKey: 'injected-key',
    clientId: 'injected-client',
    clientSecret: 'injected-secret',
    tenantId: 'injected-tenant'
  };

  const ref = normalizeSnowflakeRef(injected);
  assert.deepEqual(Object.keys(ref).sort(), ['account', 'connector', 'database', 'endpoint', 'role', 'schema', 'table', 'token', 'warehouse']);
  assert.equal('authenticator' in ref, false);
  assert.equal('password' in ref, false);
  assert.equal('privateKey' in ref, false);
  assert.equal('clientId' in ref, false);

  const options = snowflakeSdkOptions(ref);
  assert.deepEqual(Object.keys(options).sort(), ['account', 'database', 'role', 'schema', 'username', 'warehouse']);
  for (const forbidden of ['authenticator', 'token', 'password', 'privateKey', 'clientId', 'clientSecret', 'tenantId', 'accessUrl']) {
    assert.equal(forbidden in options, false, `snowflakeSdkOptions must not forward ${forbidden}`);
  }
});

test('no SPOOL connector source references an Azure credential class', async () => {
  const files = await walk(join(root, 'src', 'connectors'));
  const offenders = [];
  for (const file of files.filter(name => name.endsWith('.js'))) {
    const text = readFileSync(file, 'utf8');
    if (AZURE_CREDENTIAL_SURFACE.test(text)) offenders.push(file.slice(root.length + 1));
  }
  assert.deepEqual(offenders, [], 'connectors must not construct Azure credentials');
});
