import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const RELEASE_SHA = process.env.SPOOL_COMMIT_SHA && /^[a-f0-9]{40}$/i.test(process.env.SPOOL_COMMIT_SHA)
  ? process.env.SPOOL_COMMIT_SHA.toLowerCase()
  : '0123456789abcdef0123456789abcdef01234567';
const APPROVAL_KEY = 'package-verify-0123456789abcdef0123456789abcdef';

function run(command, args, options = {}) {
  const child = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options
  });
  if (child.status !== 0) {
    throw new Error(`Command failed (${child.status}): ${command} ${args.join(' ')}\nstdout=${child.stdout}\nstderr=${child.stderr}`);
  }
  return child;
}

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label} did not return valid JSON: ${error.message}\n${text}`); }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'spool-package-verify-'));
  try {
    const packDir = join(root, 'pack');
    const prefix = join(root, 'prefix');
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    await Promise.all([mkdir(packDir), mkdir(prefix), mkdir(sourceRoot), mkdir(targetRoot)]);

    const packed = run(npm, ['pack', '--json', '--pack-destination', packDir], { cwd: resolve('.') });
    const packInfo = parseJson(packed.stdout, 'npm pack');
    if (!Array.isArray(packInfo) || packInfo.length !== 1 || !packInfo[0]?.filename) throw new Error('npm pack returned an unexpected result');
    const tarball = join(packDir, packInfo[0].filename);
    if (!existsSync(tarball)) throw new Error(`Packed artifact missing: ${tarball}`);

    run(npm, ['install', '--global', '--prefix', prefix, tarball]);
    const spool = process.platform === 'win32' ? join(prefix, 'spool.cmd') : join(prefix, 'bin', 'spool');
    if (!existsSync(spool)) throw new Error(`Installed spool binary missing: ${spool}`);

    const help = run(spool, ['--help']);
    const helpJson = parseJson(help.stdout, 'spool --help');
    if (helpJson.name !== 'spool' || !helpJson.commands?.includes('receipt')) throw new Error('Installed binary returned an invalid command contract');

    await copyFile('examples/crm-export/source.csv', join(sourceRoot, 'source.csv'));
    const targetSql = await readFile('examples/crm-export/target.sql', 'utf8');
    const targetPath = join(targetRoot, 'target.db');
    const db = new Database(targetPath);
    db.exec(targetSql);
    db.close();
    const requestPath = join(root, 'request.json');
    await copyFile('examples/crm-export/request.json', requestPath);
    const statePath = join(targetRoot, 'spool-state.db');
    const approvalPath = join(root, 'approval.json');
    const resultPath = join(root, 'run-result.json');
    const receiptPath = join(root, 'receipt.json');
    const common = ['--request', requestPath, '--source-root', sourceRoot, '--target-root', targetRoot, '--state', statePath];
    const env = {
      ...process.env,
      SPOOL_APPROVAL_KEY: APPROVAL_KEY,
      SPOOL_COMMIT_SHA: RELEASE_SHA,
      SPOOL_RELEASE_VERSION: '1.0.0'
    };

    const inspect = parseJson(run(spool, ['inspect', ...common], { env }).stdout, 'spool inspect').result;
    if (inspect.sourceRows !== 5 || inspect.targetPreflight?.status !== 'READY') throw new Error(`Installed inspect failed: ${JSON.stringify(inspect)}`);

    const dry = parseJson(run(spool, ['dry-run', ...common], { env }).stdout, 'spool dry-run').result;
    if (dry.validRows !== 3 || dry.invalidRows !== 2) throw new Error(`Installed dry-run counts changed: ${JSON.stringify(dry)}`);

    run(spool, ['approve', ...common, '--expires', '2099-01-01T00:00:00.000Z', '--nonce', 'package-verify', '--out', approvalPath], { env });
    run(spool, ['run', ...common, '--approval', approvalPath, '--out', resultPath], { env });
    run(spool, ['receipt', '--migration-id', 'crm_import_example_v1', '--source-root', sourceRoot, '--target-root', targetRoot, '--state', statePath, '--out', receiptPath], { env });

    const result = parseJson(await readFile(resultPath, 'utf8'), 'installed run result');
    const receipt = parseJson(await readFile(receiptPath, 'utf8'), 'installed receipt');
    if (result.status !== 'COMPLETE' || result.verification?.status !== 'VERIFIED') throw new Error(`Installed run did not verify: ${JSON.stringify(result)}`);
    const counts = receipt.record?.counts;
    if (counts?.sourceRows !== 5 || counts?.writtenRows !== 3 || counts?.rejectedRows !== 2 || counts?.filteredRows !== 0) {
      throw new Error(`Installed receipt counts changed: ${JSON.stringify(counts)}`);
    }
    if (receipt.record?.release?.commitSha !== RELEASE_SHA) throw new Error('Installed receipt is not bound to the expected release SHA');

    const verifyDb = new Database(targetPath, { readonly: true });
    const rowCount = Number(verifyDb.prepare('SELECT COUNT(*) AS count FROM customers').get().count);
    const ledgerCount = Number(verifyDb.prepare('SELECT COUNT(*) AS count FROM __spool_batch_ledger WHERE migration_id=?').get('crm_import_example_v1').count);
    verifyDb.close();
    if (rowCount !== 3 || ledgerCount !== 3) throw new Error(`Installed target evidence changed: rows=${rowCount} ledger=${ledgerCount}`);

    process.stdout.write(`${JSON.stringify({ status: 'PASS', tarball: packInfo[0].filename, installedBinary: spool, sourceRows: 5, writtenRows: 3, rejectedRows: 2, ledgerEntries: 3, releaseCommit: RELEASE_SHA }, null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
