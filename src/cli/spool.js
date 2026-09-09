#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { SpoolCommandService } from '../daemon/command-service.js';

const COMMANDS = ['inspect', 'plan', 'dry-run', 'approve', 'run', 'status', 'verify', 'receipt'];

function help() {
  return {
    name: 'spool',
    commands: COMMANDS,
    usage: 'spool <command> --request migration.json --source-root DIR --target-root DIR --state FILE [--approval FILE] [--expires ISO --nonce VALUE]',
    environment: ['SPOOL_APPROVAL_KEY (required, >=16 bytes)', 'SPOOL_COMMIT_SHA (optional when git checkout is available)', 'SPOOL_RELEASE_VERSION (optional)']
  };
}

function usage(message) {
  const error = new Error(message);
  error.code = 'CLI_USAGE';
  error.nextActions = ['Run `spool --help`', 'Provide the required command flags'];
  throw error;
}

function parse(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv[0] === 'help') return { command: 'help', flags: {} };
  const command = argv[0];
  if (!COMMANDS.includes(command)) usage(`Unknown command ${command}`);
  const flags = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) usage(`Unexpected argument ${token}`);
    const name = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for --${name}`);
    flags[name] = value; i += 1;
  }
  return { command, flags };
}

async function jsonFile(path, label) {
  if (!path) usage(`${label} file is required`);
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { usage(`Cannot read ${label} JSON: ${error.message}`); }
}

async function packageVersion() {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  return process.env.SPOOL_RELEASE_VERSION ?? pkg.version;
}

function commitSha() {
  if (/^[a-f0-9]{40}$/.test(process.env.SPOOL_COMMIT_SHA ?? '')) return process.env.SPOOL_COMMIT_SHA;
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^[a-f0-9]{40}$/.test(sha)) return sha;
  } catch { /* handled below */ }
  usage('Exact release commit is unavailable; set SPOOL_COMMIT_SHA to the running source SHA');
}

function errorEnvelope(error) {
  return {
    ok: false,
    error: {
      code: error?.code ?? 'CLI_ERROR',
      message: String(error?.message ?? error),
      nextActions: Array.isArray(error?.nextActions) ? error.nextActions : ['Review the error code and migration inputs']
    }
  };
}

async function main() {
  const { command, flags } = parse(process.argv.slice(2));
  if (command === 'help') {
    process.stdout.write(`${JSON.stringify(help())}\n`);
    return;
  }

  for (const name of ['source-root', 'target-root', 'state']) if (!flags[name]) usage(`--${name} is required`);
  const approvalSigningKey = process.env.SPOOL_APPROVAL_KEY;
  if (typeof approvalSigningKey !== 'string' || approvalSigningKey.length < 16) usage('SPOOL_APPROVAL_KEY must be set to at least 16 bytes');
  const service = await SpoolCommandService.create({
    sourceRoot: flags['source-root'],
    targetRoot: flags['target-root'],
    statePath: flags.state,
    approvalSigningKey,
    release: { version: await packageVersion(), commitSha: commitSha() }
  });
  try {
    let result;
    if (['status', 'verify', 'receipt'].includes(command)) {
      let migrationId = flags['migration-id'];
      if (!migrationId && flags.request) migrationId = (await jsonFile(flags.request, 'request')).migrationId;
      if (!migrationId) usage('--migration-id or --request is required');
      result = command === 'status' ? service.status(migrationId) : command === 'verify' ? service.verification(migrationId) : service.receipt(migrationId);
    } else {
      const request = await jsonFile(flags.request, 'request');
      if (command === 'inspect') result = await service.inspect(request);
      else if (command === 'plan') result = await service.plan(request);
      else if (command === 'dry-run') result = await service.dryRun(request);
      else if (command === 'approve') {
        if (!flags.expires || !flags.nonce) usage('approve requires --expires and --nonce');
        result = await service.approve(request, { expiresAt: flags.expires, nonce: flags.nonce });
      } else if (command === 'run') {
        const approval = flags.approval ? await jsonFile(flags.approval, 'approval') : null;
        result = await service.run(request, { approval });
      }
    }
    process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
  } finally { service.close(); }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify(errorEnvelope(error))}\n`);
  process.exitCode = error?.code === 'CLI_USAGE' ? 2 : 1;
});
