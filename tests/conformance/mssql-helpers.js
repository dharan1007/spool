import sql from 'mssql';

export const MSSQL_TEST_ENV = {
  endpoint: process.env.SPOOL_TEST_MSSQL_ENDPOINT ?? '',
  database: process.env.SPOOL_TEST_MSSQL_DATABASE ?? 'spooltest',
  user: process.env.SPOOL_TEST_MSSQL_USER ?? 'sa',
  password: process.env.SPOOL_TEST_MSSQL_PASSWORD ?? '',
  readerUser: process.env.SPOOL_TEST_MSSQL_READER_USER ?? 'spool_reader',
  readerPassword: process.env.SPOOL_TEST_MSSQL_READER_PASSWORD ?? ''
};

export const MSSQL_TEST_ENABLED = Boolean(
  MSSQL_TEST_ENV.endpoint && MSSQL_TEST_ENV.password && MSSQL_TEST_ENV.readerPassword
);

export function mssqlPoolConfig(asUser, asPassword, asDatabase = MSSQL_TEST_ENV.database) {
  const url = new URL(MSSQL_TEST_ENV.endpoint);
  return {
    server: url.hostname,
    port: Number(url.port || 1433),
    user: asUser,
    password: asPassword,
    database: asDatabase,
    options: { encrypt: false, trustServerCertificate: true, connectTimeout: 10_000, requestTimeout: 65_000 },
    pool: { max: 1, min: 0, idleTimeoutMillis: 10_000 }
  };
}

async function saPool(asDatabase = 'master') {
  const pool = new sql.ConnectionPool(mssqlPoolConfig(MSSQL_TEST_ENV.user, MSSQL_TEST_ENV.password, asDatabase));
  await pool.connect();
  return pool;
}

export async function waitForMssqlServer(timeoutMs = 240000) {
  const started = Date.now();
  for (;;) {
    try {
      const pool = new sql.ConnectionPool(mssqlPoolConfig(MSSQL_TEST_ENV.user, MSSQL_TEST_ENV.password, 'master'));
      await pool.connect();
      try {
        await pool.request().query('SELECT 1');
        return;
      } finally { await pool.close(); }
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for SQL Server');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

export async function ensureMssqlDatabase() {
  await waitForMssqlServer();
  const pool = await saPool('master');
  try {
    await pool.request().query('IF DB_ID(\'spooltest\') IS NULL CREATE DATABASE spooltest');
    const db = new sql.ConnectionPool(mssqlPoolConfig(MSSQL_TEST_ENV.user, MSSQL_TEST_ENV.password, 'spooltest'));
    await db.connect();
    try {
      await db.request().query('ALTER DATABASE spooltest SET ALLOW_SNAPSHOT_ISOLATION ON');
      await db.request().query(`IF NOT EXISTS (SELECT * FROM sys.server_principals WHERE name = '${MSSQL_TEST_ENV.readerUser}') CREATE LOGIN ${MSSQL_TEST_ENV.readerUser} WITH PASSWORD = '${MSSQL_TEST_ENV.readerPassword}', CHECK_POLICY = OFF`);
      await db.request().query(`IF NOT EXISTS (SELECT * FROM sys.database_principals WHERE name = '${MSSQL_TEST_ENV.readerUser}') CREATE USER ${MSSQL_TEST_ENV.readerUser} FOR LOGIN ${MSSQL_TEST_ENV.readerUser}`);
      await db.request().query(`ALTER ROLE db_datareader ADD MEMBER ${MSSQL_TEST_ENV.readerUser}`);
    } finally { await db.close(); }
  } finally { await pool.close(); }
}
