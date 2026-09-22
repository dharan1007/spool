#!/usr/bin/env node
// Real process-death driver for PostgreSQL cutover crash conformance.
//
// The parent prepares a migration through CUTOVER_ARMED and writes this child
// a temporary JSON config. The child reopens the durable RunStore, mints a
// fresh source-freeze attestation, starts commitCutover(), and deliberately
// blocks forever when the requested production fault boundary is reached.
// The parent waits for CUTOVER_BOUNDARY_REACHED and then sends SIGKILL.
//
// This differs materially from service.close(): no JS finally blocks, SQLite
// close hooks, socket shutdown, or application cleanup execute after the
// boundary signal. Recovery must therefore rely only on state durably written
// before the boundary hook.

import { readFile } from 'node:fs/promises';
import { SpoolCommandService } from '../../../src/daemon/command-service.js';

function configPath() {
  const index = process.argv.indexOf('--config');
  if (index < 0 || !process.argv[index + 1]) {
    process.stderr.write('cutover-kill-child: --config <path> required\n');
    process.exit(2);
  }
  return process.argv[index + 1];
}

async function main() {
  const cfg = JSON.parse(await readFile(configPath(), 'utf8'));
  const {
    sourceRoot, targetRoot, snapshotDir, statePath,
    approvalSigningKey, release, request, faultPoint
  } = cfg;

  if (!faultPoint || typeof faultPoint !== 'string') {
    throw new Error('faultPoint is required');
  }

  let boundaryReached = false;
  const never = new Promise(() => {});
  const faultInjector = {
    hit: async point => {
      if (point !== faultPoint) return false;
      if (!boundaryReached) {
        boundaryReached = true;
        process.stdout.write(`CUTOVER_BOUNDARY_REACHED ${point}\n`);
      }
      // Do not return from the production hook. The parent SIGKILLs this
      // process after observing the durable-boundary signal.
      await never;
      return false;
    }
  };

  const service = await SpoolCommandService.create({
    sourceRoot,
    targetRoot,
    snapshotDir,
    statePath,
    approvalSigningKey,
    release,
    faultInjector
  });

  const barrier = await service.attestCutoverBarrier(request, {
    statement: 'SIGKILL crash fixture keeps source writers disabled for the cutover attempt.',
    routingDecision: 'fixture does not route writes to the source during cutover recovery'
  });

  process.stdout.write(`CUTOVER_CHILD_READY ${faultPoint}\n`);
  await service.commitCutover(request, { sourceBarrier: barrier });

  // Reaching here means the requested hook did not execute, which invalidates
  // the crash proof.
  process.stderr.write(`cutover-kill-child: fault boundary not reached: ${faultPoint}\n`);
  process.exit(3);
}

main().catch(error => {
  process.stderr.write(`cutover-kill-child fatal: ${error?.stack ?? error}\n`);
  process.exit(1);
});
