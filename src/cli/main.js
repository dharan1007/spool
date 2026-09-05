#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SpoolError } from '../core/errors.js';
import { SpooldClient } from '../client/spoold-client.js';

const COMMANDS = new Set([
  'list_connectors',
  'list_connections',
  'put_connection',
  'test_connection',
  'create_plan',
  'run_migration',
  'inspect_job',
  'get_receipt'
]);

function usageError() {
  const error = new Error('Invalid CLI usage');
  error.code = 'CLI_USAGE_ERROR';
  throw error;
}

function parseArgs(argv) {
  if (!argv.length) usageError();
  const command = argv[0];
  if (!COMMANDS.has(command)) usageError();
  let stateDir = process.env.SPOOL_STATE_DIR?.trim() || join(homedir(), '.spool');
  let stdin = false;
  let inputFile = null;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--state-dir') {
      const value = argv[++index];
      if (!value) usageError();
      stateDir = value;
    } else if (arg === '--stdin') {
      if (stdin || inputFile) usageError();
      stdin = true;
    } else if (arg === '--input') {
      const value = argv[++index];
      if (!value || stdin || inputFile) usageError();
      inputFile = value;
    } else {
      usageError();
    }
  }

  return { command, stateDir, stdin, inputFile };
}

async function readStdin(maxBytes = 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error('CLI input is too large');
      error.code = 'CLI_INPUT_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

function parseInput(text) {
  if (!text.trim()) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const error = new Error('CLI input must be valid JSON');
    error.code = 'CLI_INPUT_INVALID';
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('CLI input must be a JSON object');
    error.code = 'CLI_INPUT_INVALID';
    throw error;
  }
  return value;
}

async function loadRequest(options) {
  if (options.stdin) return parseInput(await readStdin());
  if (options.inputFile) return parseInput(await readFile(options.inputFile, 'utf8'));
  return {};
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : 'CLI_INTERNAL_ERROR';
}

function exitCodeFor(error) {
  const code = safeCode(error);
  if (code === 'CLI_USAGE_ERROR' || code.startsWith('CLI_INPUT_')) return 2;
  if (
    code.startsWith('SPOOLD_')
    && (code.includes('NOT_RUNNING') || code.includes('PROTOCOL') || code.includes('DESCRIPTOR') || code.includes('PAIRING') || code.includes('CREDENTIAL') || code.includes('INSTANCE'))
  ) return 3;
  return 4;
}

function publicMessage(error) {
  const code = safeCode(error);
  if (code === 'CLI_USAGE_ERROR') return 'Invalid SPOOL CLI usage';
  if (code.startsWith('CLI_INPUT_')) return 'Invalid SPOOL CLI input';
  if (exitCodeFor(error) === 3) return 'Unable to connect to local spoold';
  if (error instanceof SpoolError) return 'Local spoold command failed';
  return 'SPOOL CLI command failed';
}

try {
  const options = parseArgs(process.argv.slice(2));
  const request = await loadRequest(options);
  const client = await SpooldClient.fromStateDir({ stateDir: options.stateDir });
  const result = await client.command(options.command, request);
  process.stdout.write(`${JSON.stringify({ ok: true, command: options.command, result })}\n`);
} catch (error) {
  const code = safeCode(error);
  const output = { ok: false, error: { code, message: publicMessage(error) } };
  process.stderr.write(`${JSON.stringify(output)}\n`);
  process.exitCode = exitCodeFor(error);
}
