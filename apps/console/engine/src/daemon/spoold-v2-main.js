#!/usr/bin/env node
// Production entrypoint for the SPOOL enterprise API (v2).
//
// Everything is configuration-explicit and fails closed: there is no default
// bearer token, no default approval signing key and no default release commit.
// The daemon binds a loopback address only (enforced by createSpoolDaemonV2), so
// a container deployment must reach it through a same-pod proxy.
import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { fail } from '../core/errors.js';
import { PRODUCTION_POLICY } from '../platform/production-policy.js';
import { EnterpriseRegistry } from '../enterprise/registry.js';
import { createEnterpriseOrchestrator } from '../enterprise/orchestrator.js';
import { createSpoolDaemonV2 } from './spoold-v2.js';

const MiB = 1024 * 1024;

export function daemonConfigFromEnv(env = process.env) {
  const stateDir = resolve(env.SPOOL_STATE_DIR || '/var/lib/spool');
  const token = env.SPOOL_DAEMON_TOKEN;
  if (typeof token !== 'string' || token.length < 32) {
    fail('INVALID_DAEMON_CONFIG', 'SPOOL_DAEMON_TOKEN must be provided and at least 32 bytes');
  }
  const approvalSigningKey = env.SPOOL_APPROVAL_SIGNING_KEY;
  if (typeof approvalSigningKey !== 'string' || approvalSigningKey.length < 32) {
    fail('INVALID_DAEMON_CONFIG', 'SPOOL_APPROVAL_SIGNING_KEY must be provided and at least 32 bytes');
  }
  const commitSha = env.SPOOL_RELEASE_COMMIT_SHA;
  if (typeof commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(commitSha)) {
    fail('INVALID_DAEMON_CONFIG', 'SPOOL_RELEASE_COMMIT_SHA must be the exact 40-character release commit');
  }
  const version = env.SPOOL_RELEASE_VERSION || PRODUCTION_POLICY.release;
  if (version !== PRODUCTION_POLICY.release) {
    fail('INVALID_DAEMON_CONFIG', `SPOOL_RELEASE_VERSION must match the shipped policy release ${PRODUCTION_POLICY.release}`);
  }
  const rawCeiling = env.SPOOL_SOURCE_CEILING_BYTES;
  const maxSourceBytes = rawCeiling === undefined ? PRODUCTION_POLICY.maxSourceBytes : Number(rawCeiling);
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < MiB || maxSourceBytes > PRODUCTION_POLICY.maxSourceBytes) {
    fail('INVALID_DAEMON_CONFIG', `SPOOL_SOURCE_CEILING_BYTES must be an integer between ${MiB} and ${PRODUCTION_POLICY.maxSourceBytes}`);
  }
  const port = env.SPOOL_DAEMON_PORT === undefined ? 8080 : Number(env.SPOOL_DAEMON_PORT);
  // 0 requests an ephemeral loopback port and exists for tests and sidecar
  // topologies that pass the real port explicitly.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail('INVALID_DAEMON_CONFIG', 'SPOOL_DAEMON_PORT must be an integer between 0 and 65535');
  }
  return Object.freeze({
    stateDir, token, approvalSigningKey, port, maxSourceBytes,
    release: Object.freeze({ version, commitSha })
  });
}

export async function startSpoolDaemonV2(env = process.env, { log = console } = {}) {
  const config = daemonConfigFromEnv(env);
  await mkdir(config.stateDir, { recursive: true, mode: 0o750 });
  const registry = new EnterpriseRegistry({ path: join(config.stateDir, 'registry.db') });
  const orchestrator = createEnterpriseOrchestrator({
    registry,
    approvalSigningKey: config.approvalSigningKey,
    release: config.release,
    maxSourceBytes: config.maxSourceBytes
  });
  const daemon = createSpoolDaemonV2({ orchestrator, registry, token: config.token });
  let address;
  try {
    address = await daemon.listen(config.port);
  } catch (error) {
    await daemon.close().catch(() => {});
    await orchestrator.closeAll();
    registry.close();
    throw error;
  }
  log.info(`spoold-v2 listening on ${address.host}:${address.port} release ${config.release.version} commit ${config.release.commitSha} state ${config.stateDir}`);
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await daemon.close();
    await orchestrator.closeAll();
    registry.close();
  }
  return Object.freeze({ config, daemon, orchestrator, registry, address, close });
}

async function main() {
  let running;
  try {
    running = await startSpoolDaemonV2(process.env, { log: console });
  } catch (error) {
    process.stderr.write(`spoold-v2 failed to start: ${error?.code ?? 'ERROR'} ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const shutdown = signal => {
    process.stdout.write(`spoold-v2 ${signal} shutdown\n`);
    running.close()
      .then(() => { process.exitCode = 0; })
      .catch(error => {
        process.stderr.write(`spoold-v2 shutdown failed: ${error?.code ?? 'ERROR'} ${error?.message ?? String(error)}\n`);
        process.exitCode = 1;
      });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
