import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSpooldRuntime } from './runtime.js';

function parsePort(value) {
  const port = Number(value ?? '8766');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    const error = new Error('Invalid SPOOLD_PORT');
    error.code = 'INVALID_SPOOLD_PORT';
    throw error;
  }
  return port;
}

function parseOrigins(value) {
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

const stateDir = process.env.SPOOL_STATE_DIR?.trim() || join(homedir(), '.spool');
const host = process.env.SPOOLD_HOST?.trim() || '127.0.0.1';
const port = parsePort(process.env.SPOOLD_PORT);
const allowedOrigins = parseOrigins(process.env.SPOOLD_ALLOWED_ORIGINS);

let runtime = null;
let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (runtime) await runtime.close();
  } catch {
    exitCode = 1;
  } finally {
    process.exitCode = exitCode;
  }
}

process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });

try {
  runtime = await createSpooldRuntime({ stateDir, host, port, allowedOrigins });
  const descriptor = await runtime.start();
  process.stdout.write(`${JSON.stringify(descriptor)}\n`);
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : 'SPOOLD_START_FAILED';
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message: 'spoold failed to start' } })}\n`);
  await shutdown(1);
}
