import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCdcTransactionAssembler } from '../src/connectors/postgres/cdc-apply.js';

function begin(xid = 1) {
  return { tag: 'begin', lsn: '0/10', xid };
}

function largeInsert() {
  return {
    tag: 'insert',
    lsn: '0/20',
    schema: 'public',
    table: 'src',
    row: { id: 1, payload: 'x'.repeat(4096) }
  };
}

test('CDC transaction overflow without staging fails with the stable configured-capability error', async () => {
  const assembler = createCdcTransactionAssembler({
    maxInMemoryBytes: 1024,
    maxInMemoryEvents: 100,
    stagingDir: null
  });
  await assembler.feed(begin(11));

  await assert.rejects(
    () => assembler.feed(largeInsert()),
    error => error?.code === 'CDC_TRANSACTION_TOO_LARGE'
  );

  assert.equal(assembler.hasOpenTransaction(), true);
  const abandoned = await assembler.abortOpenTransaction();
  assert.equal(abandoned.xid, 11);
  assert.equal(assembler.hasOpenTransaction(), false);
});

test('CDC staging filesystem failure is classified and open transaction can be cleanly aborted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-cdc-staging-io-'));
  const notDirectory = join(root, 'not-a-directory');
  await writeFile(notDirectory, 'block mkdir', 'utf8');

  const assembler = createCdcTransactionAssembler({
    maxInMemoryBytes: 1024,
    maxInMemoryEvents: 100,
    stagingDir: notDirectory
  });

  try {
    await assembler.feed(begin(12));
    await assert.rejects(
      () => assembler.feed(largeInsert()),
      error => error?.code === 'CDC_STAGING_IO_ERROR'
        && typeof error?.details?.cause === 'string'
    );

    // The caller's terminal-failure cleanup must be able to deterministically
    // release the assembler state; no watermark/commit was produced.
    assert.equal(assembler.hasOpenTransaction(), true);
    const abandoned = await assembler.abortOpenTransaction();
    assert.equal(abandoned.xid, 12);
    assert.equal(assembler.hasOpenTransaction(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
