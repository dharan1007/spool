import { acquirePostgresTableShareLockBarrier } from '../../src/cutover/write-barrier.js';

const sourceRef = JSON.parse(process.env.SPOOL_BARRIER_SOURCE_REF ?? 'null');
const password = process.env.SPOOL_TEST_PG_PASSWORD ?? process.env.SPOOL_TEST_POSTGRES_PASSWORD ?? '';
if (!sourceRef || !password) {
  process.stderr.write('missing barrier child configuration\n');
  process.exit(2);
}

const broker = { withSecret: async (_ref, fn) => fn(password) };
const barrier = await acquirePostgresTableShareLockBarrier({
  migrationId: process.env.SPOOL_BARRIER_MIGRATION_ID ?? 'barrier-child',
  sourceRef,
  credentialBroker: broker,
  lockTimeoutMs: 10_000,
  probeTimeoutMs: 200
});

process.stdout.write(JSON.stringify({
  event: 'ready',
  barrierId: barrier.barrierId,
  backendPid: barrier.proof.backendPid,
  finalLsn: barrier.finalLsn
}) + '\n');

let closing = false;
async function close(code) {
  if (closing) return;
  closing = true;
  try { await barrier.release(); } catch {}
  process.exit(code);
}

process.on('SIGTERM', () => { void close(0); });
process.on('SIGINT', () => { void close(0); });

setInterval(async () => {
  try {
    await barrier.verifyHeld();
  } catch (error) {
    process.stderr.write(`barrier lost: ${error?.code ?? error?.message ?? error}\n`);
    process.exit(3);
  }
}, 1000);
