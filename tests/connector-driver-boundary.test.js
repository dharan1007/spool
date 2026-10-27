import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConnectorDriver } from '../src/connectors/driver-loader.js';
import { loadMssqlDriver } from '../src/connectors/mssql/driver.js';
import { loadSnowflakeDriver } from '../src/connectors/snowflake/driver.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPTIONAL_DRIVERS = ['mssql', 'snowflake-sdk'];
const STATIC_DRIVER_IMPORT = /(?:from|require\s*\()\s*['"](?:mssql|snowflake-sdk)['"]/;

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

function lockEntryKey(packages, fromKey, name) {
  let base = fromKey;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const marker = base.lastIndexOf('/node_modules/');
    base = marker === -1 ? '' : base.slice(0, marker);
  }
}

function productionClosure(packages, dependencies) {
  const seen = new Set();
  const pending = Object.keys(dependencies).map(name => ({ from: '', name }));
  while (pending.length) {
    const { from, name } = pending.pop();
    const key = lockEntryKey(packages, from, name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = packages[key] ?? {};
    for (const dependency of Object.keys({ ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) })) {
      pending.push({ from: key, name: dependency });
    }
  }
  return new Set([...seen].map(key => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)));
}

test('optional connector drivers are never imported at module load', async () => {
  const offenders = [];
  for (const file of (await walk(join(root, 'src'))).filter(name => name.endsWith('.js'))) {
    const text = await readFile(file, 'utf8');
    if (STATIC_DRIVER_IMPORT.test(text)) offenders.push(file.slice(root.length + 1));
  }
  assert.deepEqual(offenders, [], 'optional drivers must be loaded through src/connectors/driver-loader.js');
});

test('the production dependency closure excludes the optional drivers and MSAL', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));

  for (const driver of OPTIONAL_DRIVERS) {
    assert.equal(manifest.dependencies?.[driver], undefined, `${driver} must not be a production dependency`);
    assert.ok(manifest.devDependencies?.[driver], `${driver} stays a development dependency for conformance tests`);
  }

  const closure = productionClosure(lock.packages ?? {}, manifest.dependencies ?? {});
  for (const forbidden of [...OPTIONAL_DRIVERS, '@azure/msal-node', '@azure/identity']) {
    assert.equal(closure.has(forbidden), false, `${forbidden} must not be reachable from production dependencies`);
  }
  for (const required of ['better-sqlite3', 'pg', 'mysql2', '@google-cloud/bigquery']) {
    assert.equal(closure.has(required), true, `${required} remains part of the production install`);
  }
});

test('the core daemon module graph loads without either optional driver', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-driver-graph-'));
  try {
    await writeFile(join(dir, 'recorder.mjs'), [
      "import { register } from 'node:module';",
      "register('./hook.mjs', import.meta.url);",
      ''
    ].join('\n'));
    await writeFile(join(dir, 'hook.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      'export async function resolve(specifier, context, nextResolve) {',
      "  if (specifier === 'mssql' || specifier === 'snowflake-sdk' || specifier.startsWith('@azure/')) {",
      '    try { appendFileSync(process.env.SPOOL_DRIVER_PROBE_LOG, specifier + "\\n"); } catch {}',
      '  }',
      '  return nextResolve(specifier, context);',
      '}',
      ''
    ].join('\n'));
    const recorder = pathToFileURL(join(dir, 'recorder.mjs')).href;
    const log = join(dir, 'drivers.log');

    const run = target => spawnSync(process.execPath, ['--import', recorder, '--input-type=module', '-e', target], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, SPOOL_DRIVER_PROBE_LOG: log },
      timeout: 60_000
    });

    const core = run([
      "await import('./src/daemon/command-service.js');",
      "await import('./src/daemon/durable-source.js');",
      "await import('./src/connectors/mssql/runtime.js');",
      "await import('./src/connectors/snowflake/index.js');"
    ].join(' '));
    assert.equal(core.status, 0, core.stderr);
    const coreLog = existsSync(log) ? (await readFile(log, 'utf8')).trim() : '';
    assert.equal(coreLog, '', `the core graph must not resolve optional drivers, saw: ${coreLog}`);

    // Proves the recorder observes a real import; otherwise the assertion above is vacuous.
    await rm(log, { force: true });
    const forced = run("await import('mssql');");
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(await readFile(log, 'utf8'), /^mssql$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing optional driver fails closed with an actionable error', async () => {
  await assert.rejects(
    loadConnectorDriver({
      specifier: 'spool-missing-connector-driver',
      connector: 'mssql',
      installHint: 'install it with "npm install mssql@^12.7.2"'
    }),
    error => {
      assert.equal(error.code, 'CONNECTOR_DRIVER_UNAVAILABLE');
      assert.match(error.message, /mssql/);
      assert.match(error.message, /npm install mssql/);
      return true;
    }
  );
});

test('an incompatible driver shape or major is rejected before use', async () => {
  await assert.rejects(
    loadConnectorDriver({ specifier: 'node:path', connector: 'mssql', requiredExports: ['ConnectionPool'] }),
    error => error.code === 'CONNECTOR_DRIVER_INCOMPATIBLE' && error.details.missing.includes('ConnectionPool')
  );

  if (!existsSync(join(root, 'node_modules', 'snowflake-sdk', 'package.json'))) {
    return;
  }
  await assert.rejects(
    loadConnectorDriver({ specifier: 'snowflake-sdk', connector: 'snowflake', supportedMajor: 2 }),
    error => error.code === 'CONNECTOR_DRIVER_INCOMPATIBLE' && /major 2/.test(error.message)
  );
});

test('installed optional drivers load through the boundary', async () => {
  if (!OPTIONAL_DRIVERS.every(driver => existsSync(join(root, 'node_modules', driver, 'package.json')))) {
    return;
  }
  const mssql = await loadMssqlDriver();
  assert.equal(typeof mssql.ConnectionPool, 'function');
  assert.equal(typeof mssql.Transaction, 'function');
  const snowflake = await loadSnowflakeDriver();
  assert.equal(typeof snowflake.createConnection, 'function');
});

test('the packed production artifact reports the missing driver instead of crashing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-pack-driver-'));
  try {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    assert.ok(existsSync(npmCli), 'npm CLI is required to verify the packed artifact');
    const packed = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--pack-destination', dir], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000
    });
    assert.equal(packed.status, 0, packed.stderr);

    const tarball = (await readdir(dir)).find(name => name.endsWith('.tgz'));
    assert.ok(tarball, 'npm pack did not produce a tarball');
    const extracted = join(dir, 'extracted');
    await mkdir(extracted);
    const untar = spawnSync('tar', ['-xzf', join(dir, tarball), '-C', extracted], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(untar.status, 0, untar.stderr);

    const packageRoot = join(extracted, 'package');
    assert.ok(existsSync(join(packageRoot, 'src', 'connectors', 'mssql', 'driver.js')), 'the connector adapter must ship');
    assert.ok(existsSync(join(packageRoot, 'src', 'connectors', 'snowflake', 'driver.js')), 'the connector adapter must ship');
    assert.equal(existsSync(join(packageRoot, 'node_modules')), false, 'the package must not embed node_modules');

    const probe = join(dir, 'probe.mjs');
    await writeFile(probe, [
      "import { pathToFileURL } from 'node:url';",
      'const { withMssqlConnection } = await import(pathToFileURL(process.argv[2]).href);',
      "const credentialBroker = { withSecret: async (_ref, fn) => fn('not-a-real-password') };",
      'try {',
      "  await withMssqlConnection({ targetRef: { secretRef: 'env:SPOOL_TEST_SECRET' }, credentialBroker }, async () => 'connected');",
      "  console.log(JSON.stringify({ code: null, message: 'unexpected success' }));",
      '} catch (error) {',
      '  console.log(JSON.stringify({ code: error?.code ?? null, message: error?.message ?? String(error) }));',
      '}',
      ''
    ].join('\n'));
    const result = spawnSync(process.execPath, [probe, join(packageRoot, 'src', 'connectors', 'mssql', 'connection.js')], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000
    });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(outcome.code, 'CONNECTOR_DRIVER_UNAVAILABLE');
    assert.match(outcome.message, /npm install mssql/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
