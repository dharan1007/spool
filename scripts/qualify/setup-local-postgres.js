#!/usr/bin/env node
// Disposable LOCAL PostgreSQL qualification instance.
//
// Creates and manages a second, fully isolated PostgreSQL cluster owned
// entirely by SPOOL qualification. It never reads, writes, restarts or
// reconfigures any other PostgreSQL instance (in particular the machine's
// shared service cluster, which hosts unrelated project databases).
//
// Identity model (fail closed):
//   - every operation is confined to the qualification base directory below;
//   - the data directory must contain the .spool-qualification-instance marker
//     written at creation before any mutation or restore is attempted;
//   - no path outside the base directory is ever passed to initdb/pg_ctl/rm.
//
// Usage:
//   node scripts/qualify/setup-local-postgres.js --status
//   node scripts/qualify/setup-local-postgres.js --apply
//   node scripts/qualify/setup-local-postgres.js --start
//   node scripts/qualify/setup-local-postgres.js --stop
//   node scripts/qualify/setup-local-postgres.js --restore
//
// Secrets: generated passwords are written ONLY to the env file under the
// user's local application data directory (outside the repository). They are
// never printed, never committed, and never included in evidence records.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { Client } from 'pg';
import { checkDiskPreflight, measureDisk } from './disk-preflight.js';

const MARKER = '.spool-qualification-instance';
const QUALIFY_PORT = 5433;
const SUPERUSER = 'postgres';
const QUALIFY_ROLE = 'spooltest';
const QUALIFY_DB = 'spooltest';
const INSTANCE_ID = 'spool-qualification-local-pg';
const EXE = {
  initdb: process.platform === 'win32' ? 'initdb.exe' : 'initdb',
  pg_ctl: process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'
};

// Utility statements (CREATE/ALTER ROLE, CREATE DATABASE) do not accept
// bind parameters. Identifiers must be double-quoted, string values
// single-quoted; generated passwords are base64url ([A-Za-z0-9_-]) but are
// still escaped defensively before interpolation.
function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
function sqlIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function portFree(port) {
  return new Promise(resolvePort => {
    const server = createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => server.close(() => resolvePort(true)));
    server.listen(port, '127.0.0.1');
  });
}

function baseDir() {
  const root = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'spool-qualify')
    : join(homedir(), '.spool-qualify');
  return resolve(root);
}

function dataDir() { return join(baseDir(), 'pg-data'); }
function envFilePath() { return join(baseDir(), 'spooltest.env'); }
function recordPath() { return join(baseDir(), 'instance-record.json'); }
function backupsDir() { return join(baseDir(), 'backups'); }

// statfs fails on a path that does not exist yet; probe the nearest existing
// ancestor instead (same volume in practice for LOCALAPPDATA-based paths).
function diskProbePath() {
  let dir = baseDir();
  while (!existsSync(dir)) {
    const parent = resolve(dir, '..');
    if (parent === dir) return process.cwd();
    dir = parent;
  }
  return dir;
}

function die(message, code = 1) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

function findPgBin() {
  if (process.env.SPOOL_QUALIFY_PG_BIN && existsSync(join(process.env.SPOOL_QUALIFY_PG_BIN, 'initdb.exe'))) {
    return process.env.SPOOL_QUALIFY_PG_BIN;
  }
  const exe = process.platform === 'win32' ? 'initdb.exe' : 'initdb';
  const candidates = [];
  if (process.platform === 'win32') {
    for (const base of ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL']) {
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) candidates.push(join(base, entry, 'bin'));
    }
  }
  const pathDirs = String(process.env.PATH ?? '').split(delimiter).filter(Boolean);
  candidates.push(...pathDirs);
  for (const dir of candidates) {
    try { if (existsSync(join(dir, exe))) return dir; } catch { /* keep looking */ }
  }
  return null;
}

function run(bin, args, options = {}) {
  return execFileSync(join(bin, options.exe ?? EXE.initdb), args, {
    encoding: 'utf8',
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024
  });
}

function pgCtl(bin, args) {
  try {
    return { ok: true, output: run(bin, args, { exe: EXE.pg_ctl, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, output: String(error.stdout ?? '') + String(error.stderr ?? '') + String(error.message ?? '') };
  }
}

function readEnvFile() {
  if (!existsSync(envFilePath())) return {};
  const out = {};
  for (const line of readFileSync(envFilePath(), 'utf8').split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1);
  }
  return out;
}

function writeEnvFile(entries) {
  mkdirSync(baseDir(), { recursive: true });
  writeFileSync(envFilePath(), Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
}

function hasMarker() {
  return existsSync(join(dataDir(), MARKER));
}

function assertOwnInstance() {
  if (!hasMarker()) {
    die(`Refusing to act: ${dataDir()} is not a marked SPOOL qualification instance. ` +
      'This tool only ever operates on its own disposable instance.');
  }
}

async function adminClient(env) {
  const client = new Client({
    host: '127.0.0.1',
    port: QUALIFY_PORT,
    database: 'postgres',
    user: SUPERUSER,
    password: env.SPOOL_QUALIFY_ADMIN_PASSWORD ?? '',
    ssl: false,
    connectionTimeoutMillis: 5000
  });
  await client.connect();
  return client;
}

async function queryAll(sql, params = []) {
  const env = readEnvFile();
  const client = await adminClient(env);
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    await client.end().catch(() => {});
  }
}

async function collectSettings() {
  const wanted = [
    'port', 'listen_addresses', 'wal_level', 'max_replication_slots', 'max_wal_senders',
    'max_connections', 'server_encoding', 'TimeZone', 'password_encryption', 'data_directory'
  ];
  const rows = await queryAll(`SELECT name, setting, unit, vartype FROM pg_settings WHERE name = ANY($1) ORDER BY name`, [wanted]);
  const settings = {};
  for (const row of rows) settings[row.name] = row.setting;
  const version = await queryAll('SHOW server_version');
  return { serverVersion: version[0].server_version, settings };
}

async function status(bin) {
  const running = existsSync(join(dataDir(), 'postmaster.pid'));
  const record = existsSync(recordPath()) ? JSON.parse(readFileSync(recordPath(), 'utf8')) : null;
  const report = {
    instanceId: INSTANCE_ID,
    baseDir: baseDir(),
    dataDir: dataDir(),
    port: QUALIFY_PORT,
    markerPresent: hasMarker(),
    running,
    record: record ? { createdAt: record.createdAt, pgBin: record.pgBin, walLevel: record.walLevel, marker: record.marker } : null,
    disk: measureDisk(diskProbePath())
  };
  if (running && hasMarker()) {
    try {
      report.server = await collectSettings();
      report.databases = await queryAll(`SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1`);
      report.roles = await queryAll(`SELECT rolname, rolcanlogin, rolreplication FROM pg_roles WHERE rolname = $1`, [QUALIFY_ROLE]);
    } catch (error) {
      report.serverError = String(error?.message ?? error);
    }
  }
  if (bin) report.pgBin = bin;
  console.log(JSON.stringify(report, null, 2));
}

async function apply() {
  const bin = findPgBin();
  if (!bin) die('PostgreSQL binaries (initdb/pg_ctl) not found. Set SPOOL_QUALIFY_PG_BIN.');

  // Disk preflight: instance creation is a bounded conformance-sized footprint.
  const disk = checkDiskPreflight({ kind: 'conformance', estimatedPeakBytes: 512 * 1024 * 1024, path: diskProbePath() });
  if (!disk.allowed) die(`Disk preflight refused instance creation: ${disk.reason}`, 2);

  mkdirSync(baseDir(), { recursive: true });
  mkdirSync(backupsDir(), { recursive: true });

  const env = readEnvFile();
  const existing = hasMarker();
  let configChanged = false;

  if (!existing) {
    if (existsSync(dataDir()) && readdirSync(dataDir()).length > 0) {
      die(`Data directory ${dataDir()} exists, is non-empty and lacks the ${MARKER} marker. Refusing.`);
    }
    mkdirSync(dataDir(), { recursive: true });

    const adminPassword = env.SPOOL_QUALIFY_ADMIN_PASSWORD ?? randomBytes(24).toString('base64url');
    const pwFile = join(tmpdir(), `spool-initdb-${randomBytes(6).toString('hex')}.pw`);
    writeFileSync(pwFile, adminPassword + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      console.log('[setup] running initdb (takes up to a minute, no output)...');
      run(bin, [
        '-D', dataDir(),
        '-U', SUPERUSER,
        '--auth-local=scram-sha-256',
        '--auth-host=scram-sha-256',
        '--pwfile', pwFile,
        '--encoding=UTF8',
        '--locale=C'
      ]);
    } finally {
      try { rmSync(pwFile, { force: true }); } catch { /* best effort */ }
    }

    writeFileSync(join(dataDir(), MARKER), JSON.stringify({
      instanceId: INSTANCE_ID,
      createdAt: new Date().toISOString(),
      note: 'Disposable SPOOL qualification PostgreSQL instance. Owned by scripts/qualify/setup-local-postgres.js.'
    }, null, 2), { encoding: 'utf8' });

    // Bounded, deterministic configuration.
    const conf = join(dataDir(), 'postgresql.conf');
    copyFileSync(conf, join(backupsDir(), `postgresql.conf.created-${Date.now()}`));
    const additions = [
      '',
      '# --- SPOOL qualification settings (spool-qualification-local-pg) ---',
      `port = ${QUALIFY_PORT}`,
      "listen_addresses = '127.0.0.1'",
      'wal_level = logical',
      'max_replication_slots = 10',
      'max_wal_senders = 10',
      'max_connections = 50',
      "password_encryption = 'scram-sha-256'",
      "log_line_prefix = '%m [%p] '",
      '# --- end SPOOL qualification settings ---',
      ''
    ].join('\n');
    appendFileSyncCompat(conf, additions);

    // pg_hba: local scope only, SCRAM password auth for the qualification role
    // and superuser; replication connections require their own rule.
    const hba = join(dataDir(), 'pg_hba.conf');
    copyFileSync(hba, join(backupsDir(), `pg_hba.conf.created-${Date.now()}`));
    const hbaAdditions = [
      '',
      '# --- SPOOL qualification rules (spool-qualification-local-pg) ---',
      `local   all             ${SUPERUSER}                          scram-sha-256`,
      'local   all             all                                 scram-sha-256',
      `host    all             ${SUPERUSER}       127.0.0.1/32        scram-sha-256`,
      `host    all             ${QUALIFY_ROLE}       127.0.0.1/32        scram-sha-256`,
      `host    replication     ${SUPERUSER}       127.0.0.1/32        scram-sha-256`,
      `host    replication     ${QUALIFY_ROLE}       127.0.0.1/32        scram-sha-256`,
      '# --- end SPOOL qualification rules ---',
      ''
    ].join('\n');
    appendFileSyncCompat(hba, hbaAdditions);
    configChanged = true;

    writeEnvFile({
      SPOOL_QUALIFY_ADMIN_PASSWORD: adminPassword,
      SPOOL_TEST_POSTGRES_ENDPOINT: `postgresql://127.0.0.1:${QUALIFY_PORT}/?sslmode=disable`,
      SPOOL_TEST_POSTGRES_DATABASE: QUALIFY_DB,
      SPOOL_TEST_POSTGRES_USER: QUALIFY_ROLE,
      SPOOL_TEST_PG_PASSWORD: env.SPOOL_TEST_PG_PASSWORD ?? randomBytes(24).toString('base64url')
    });
    console.log('instance created (passwords stored only in the env file, never printed)');
  } else {
    // Idempotent re-apply: refresh only the SPOOL-managed config blocks.
    if (!env.SPOOL_TEST_PG_PASSWORD) {
      writeEnvFile({ ...readEnvFile(), SPOOL_TEST_PG_PASSWORD: randomBytes(24).toString('base64url') });
    }
    console.log('instance already initialized; ensuring configuration blocks');
    configChanged = ensureBlock(join(dataDir(), 'postgresql.conf'), [
      '# --- SPOOL qualification settings (spool-qualification-local-pg) ---',
      `port = ${QUALIFY_PORT}`,
      "listen_addresses = '127.0.0.1'",
      'wal_level = logical',
      'max_replication_slots = 10',
      'max_wal_senders = 10',
      'max_connections = 50',
      "password_encryption = 'scram-sha-256'",
      '# --- end SPOOL qualification settings ---'
    ]) || ensureBlock(join(dataDir(), 'pg_hba.conf'), [
      '# --- SPOOL qualification rules (spool-qualification-local-pg) ---',
      `host    all             ${QUALIFY_ROLE}       127.0.0.1/32        scram-sha-256`,
      `host    replication     ${QUALIFY_ROLE}       127.0.0.1/32        scram-sha-256`,
      '# --- end SPOOL qualification rules ---'
    ]);
  }

  // (Re)start the instance: reload for a live instance with unchanged config,
  // restart when SPOOL-managed settings changed (wal_level requires restart),
  // plain start when it is down. Never touches any other data directory.
  const running = pgCtl(bin, ['-D', dataDir(), 'status']).ok;
  if (!running && !(await portFree(QUALIFY_PORT))) {
    die(`Port ${QUALIFY_PORT} on 127.0.0.1 is already in use by another process. Refusing to start the qualification instance.`);
  }
  console.log(`[setup] ${running ? (configChanged ? 'restarting' : 'reloading') : 'starting'} instance on 127.0.0.1:${QUALIFY_PORT}...`);
  let op;
  if (running && configChanged) {
    op = pgCtl(bin, ['-D', dataDir(), 'restart', '-w', '-o', `-p ${QUALIFY_PORT}`]);
  } else if (running) {
    op = pgCtl(bin, ['-D', dataDir(), 'reload']);
  } else {
    op = pgCtl(bin, ['-D', dataDir(), 'start', '-w', '-o', `-p ${QUALIFY_PORT}`]);
  }
  if (!op.ok) {
    die(`Instance ${configChanged && running ? 'restart' : 'start'} failed: ${op.output.slice(0, 800)}`);
  }

  assertOwnInstance();
  const liveEnv = readEnvFile();
  console.log('[setup] ensuring disposable role and database...');

  // Create the disposable role and database (idempotent). Utility statements
  // do not accept bind parameters; identifiers are fixed constants and
  // passwords go through sqlLiteral().
  const admin = await adminClient(liveEnv);
  try {
    const role = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [QUALIFY_ROLE]);
    if (role.rowCount === 0) {
      await admin.query(`CREATE ROLE ${sqlIdent(QUALIFY_ROLE)} LOGIN REPLICATION`);
    }
    await admin.query(`ALTER ROLE ${sqlIdent(QUALIFY_ROLE)} LOGIN REPLICATION PASSWORD ${sqlLiteral(liveEnv.SPOOL_TEST_PG_PASSWORD)}`);
    const db = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [QUALIFY_DB]);
    if (db.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${sqlIdent(QUALIFY_DB)} OWNER ${sqlIdent(QUALIFY_ROLE)}`);
    }
  } finally {
    await admin.end().catch(() => {});
  }

  // Verification: settings, SCRAM path, fixtures, logical replication.
  console.log('[setup] verifying settings, SCRAM auth, fixtures and logical replication...');
  const settings = await collectSettings();
  const required = {
    wal_level: 'logical',
    password_encryption: 'scram-sha-256',
    port: String(QUALIFY_PORT),
    max_replication_slots: '10',
    max_wal_senders: '10'
  };
  const settingMismatches = Object.entries(required).filter(([k, v]) => settings.settings?.[k] !== v);
  if (settingMismatches.length) {
    die(`Post-apply verification failed, settings mismatch: ${JSON.stringify(settings.settings)}`);
  }

  const qual = new Client({
    host: '127.0.0.1', port: QUALIFY_PORT, database: QUALIFY_DB, user: QUALIFY_ROLE,
    password: liveEnv.SPOOL_TEST_PG_PASSWORD, ssl: false, connectionTimeoutMillis: 5000
  });
  await qual.connect();
  let roleCheck;
  let fixtureCheck;
  let replicationCheck;
  try {
    const who = await qual.query('SELECT current_user AS u, current_database() AS d');
    roleCheck = who.rows[0].u === QUALIFY_ROLE && who.rows[0].d === QUALIFY_DB;

    await qual.query('DROP TABLE IF EXISTS spool_qualify_fixture');
    await qual.query('CREATE TABLE spool_qualify_fixture (id integer PRIMARY KEY, v text NOT NULL)');
    await qual.query(`INSERT INTO spool_qualify_fixture (id, v) VALUES (1, 'ok')`);
    const fixture = await qual.query('SELECT count(*)::int AS c FROM spool_qualify_fixture');
    fixtureCheck = fixture.rows[0].c === 1;
    await qual.query('DROP TABLE spool_qualify_fixture');

    // Proves REPLICATION privilege + wal_level=logical on this instance.
    const slotName = `spool_qualify_probe_${Date.now()}`;
    await qual.query('SELECT pg_create_logical_replication_slot($1, $2)', [slotName, 'pgoutput']);
    await qual.query('SELECT pg_drop_replication_slot($1)', [slotName]);
    replicationCheck = true;
  } finally {
    await qual.end().catch(() => {});
  }

  if (!roleCheck || !fixtureCheck || !replicationCheck) {
    die(`Post-apply verification failed: role=${roleCheck} fixture=${fixtureCheck} replication=${replicationCheck}`);
  }

  const record = {
    instanceId: INSTANCE_ID,
    createdAt: new Date().toISOString(),
    marker: MARKER,
    pgBin: bin,
    baseDir: baseDir(),
    dataDir: dataDir(),
    port: QUALIFY_PORT,
    // Recorded per requirement; contains NO secrets.
    serverVersion: settings.serverVersion,
    settings: settings.settings,
    walLevel: settings.settings.wal_level,
    role: QUALIFY_ROLE,
    database: QUALIFY_DB,
    auth: {
      passwordEncryption: settings.settings.password_encryption,
      hostAuth: 'scram-sha-256 (127.0.0.1/32 only)',
      replicationAuth: 'scram-sha-256 (127.0.0.1/32 only)'
    },
    verification: { roleConnect: roleCheck, fixtures: fixtureCheck, logicalReplication: replicationCheck },
    disk: measureDisk(baseDir()),
    secrets: 'stored only in env file outside the repository; never recorded here'
  };
  writeFileSync(recordPath(), JSON.stringify(record, null, 2), 'utf8');
  console.log(JSON.stringify({ applied: true, recordPath: recordPath(), verification: record.verification, settings: record.settings }, null, 2));
}

function appendFileSyncCompat(file, text) {
  appendFileSync(file, text, 'utf8');
}

function ensureBlock(file, lines) {
  const content = readFileSync(file, 'utf8');
  if (content.includes(lines[0])) return false;
  appendFileSync(file, '\n' + lines.join('\n') + '\n', 'utf8');
  return true;
}

async function stop() {
  if (!hasMarker()) {
    console.log(JSON.stringify({ stopped: true, note: 'no qualification instance present' }));
    return;
  }
  const bin = findPgBin();
  if (!bin) die('PostgreSQL binaries not found.');
  const res = pgCtl(bin, ['-D', dataDir(), 'stop', '-m', 'fast', '-w']);
  console.log(JSON.stringify({ stopped: res.ok, output: res.output.slice(0, 400) }));
}

async function restore() {
  if (!hasMarker() && !existsSync(envFilePath()) && !existsSync(recordPath())) {
    console.log(JSON.stringify({ restored: true, removed: [], note: 'no qualification instance resources present' }, null, 2));
    return;
  }
  assertOwnInstance();
  const bin = findPgBin();
  if (bin) pgCtl(bin, ['-D', dataDir(), 'stop', '-m', 'fast', '-w']);
  // Delete ONLY resources this tool created, all under the base directory.
  const created = [dataDir(), envFilePath(), recordPath(), backupsDir()];
  const removed = [];
  for (const path of created) {
    if (!path.startsWith(baseDir())) die(`Refusing to remove path outside the qualification base dir: ${path}`);
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  console.log(JSON.stringify({ restored: true, removed, baseDir: baseDir() }, null, 2));
}

const arg = process.argv[2] ?? '--status';
const main = (async () => {
  if (arg === '--status') await status(findPgBin());
  else if (arg === '--apply') await apply();
  else if (arg === '--start') await apply();
  else if (arg === '--stop') await stop();
  else if (arg === '--restore') await restore();
  else die(`Unknown argument '${arg}'. Use --status | --apply | --start | --stop | --restore`);
})().catch(error => die(String(error?.stack ?? error)));

await main;
