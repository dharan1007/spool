import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { readFile } from 'node:fs/promises';

function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      shell: process.platform === 'win32' && /\.cmd$/.test(cmd)
    }).trim();
  } catch {
    return null;
  }
}

function fileSha256(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
}

export async function captureEnvironment({ pgConfig = null } = {}) {
  const cpus = os.cpus();
  const env = {
    capturedAt: new Date().toISOString(),
    os: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      kernel: tryExec('uname', ['-r']),
      hostname: os.hostname()
    },
    cpu: {
      model: cpus[0]?.model ?? null,
      logicalCount: cpus.length,
      physicalCount: null // not trivial without extra
    },
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem()
    },
    node: {
      version: process.version,
      arch: process.arch,
      platform: process.platform,
      npmVersion: tryExec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']),
      packageLockDigest: fileSha256('package-lock.json')
    },
    git: {
      sha: tryExec('git', ['rev-parse', 'HEAD']),
      dirty: (() => {
        const status = tryExec('git', ['status', '--porcelain']);
        return status ? true : false;
      })(),
      branch: tryExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
    },
    pg: {
      driverVersion: (() => { try { return JSON.parse(readFileSync('package.json','utf8')).dependencies.pg; } catch { return null; } })(),
      copyStreamsVersion: (() => { try { return JSON.parse(readFileSync('package.json','utf8')).dependencies['pg-copy-streams']; } catch { return null; } })(),
      serverVersion: null,
      settings: null
    },
    container: {
      // best-effort
      cgroup: null
    }
  };

  // Try to enrich PG server version/settings if pgConfig supplied and reachable
  if (pgConfig) {
    try {
      const { Client } = await import('pg');
      const client = new Client({ ...pgConfig, ssl: false });
      await client.connect();
      const versionRes = await client.query('SHOW server_version');
      env.pg.serverVersion = versionRes.rows[0]?.server_version ?? null;
      const settingsRes = await client.query(`
        SELECT name, setting FROM pg_settings
        WHERE name IN ('wal_level','max_wal_size','shared_buffers','work_mem','maintenance_work_mem','max_connections','max_replication_slots','max_wal_senders','synchronous_commit','fsync','full_page_writes')
        ORDER BY name
      `);
      env.pg.settings = Object.fromEntries(settingsRes.rows.map(r => [r.name, r.setting]));
      await client.end();
    } catch (e) {
      env.pg.error = e.message;
    }
  }

  // Digest of environment for manifest
  const digest = createHash('sha256').update(JSON.stringify(env)).digest('hex');
  return { env, digest: `sha256:${digest}` };
}

export function environmentDigest(env) {
  return createHash('sha256').update(JSON.stringify(env)).digest('hex');
}
