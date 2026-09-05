import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemConnector } from '../src/connectors/filesystem.js';

test('filesystem connector discovers and reads real JSONL in bounded batches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-fs-'));
  try {
    await mkdir(join(root, 'input'));
    await writeFile(join(root, 'input', 'customers.jsonl'), [
      JSON.stringify({ id: 1, name: 'Ada' }),
      JSON.stringify({ id: 2, name: 'Linus' }),
      JSON.stringify({ id: 3, name: 'Grace' })
    ].join('\n') + '\n');

    const connector = new FilesystemConnector({ root });
    const connection = await connector.validateConfig({ root });
    assert.equal((await connector.testConnection({ connection })).ok, true);

    const discovery = await connector.discover({ connection }, { resource: 'input/customers.jsonl' });
    assert.equal(discovery.resource, 'input/customers.jsonl');
    assert.equal(discovery.format, 'jsonl');
    assert.equal(discovery.rowCount, 3);
    assert.deepEqual(discovery.schema.map(field => field.name), ['id', 'name']);

    const batches = [];
    for await (const batch of connector.read({ connection }, { resource: 'input/customers.jsonl', batchSize: 2 })) {
      batches.push(batch);
    }
    assert.deepEqual(batches.map(batch => batch.rows.length), [2, 1]);
    assert.deepEqual(batches.at(-1).cursor, { offset: 3 });
    assert.deepEqual(batches.flatMap(batch => batch.rows).map(row => row.name), ['Ada', 'Linus', 'Grace']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filesystem connector rejects traversal outside configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-fs-'));
  try {
    const connector = new FilesystemConnector({ root });
    const connection = await connector.validateConfig({ root });
    await assert.rejects(
      () => connector.discover({ connection }, { resource: '../secret.csv' }),
      /PATH_OUTSIDE_ROOT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filesystem connector atomically writes and verifies a real JSONL target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-fs-'));
  try {
    await mkdir(join(root, 'out'));
    const connector = new FilesystemConnector({ root });
    const connection = await connector.validateConfig({ root });
    const request = { resource: 'out/customers.jsonl', jobId: 'job_test', mode: 'replace' };
    const plan = await connector.planWrite({ connection }, request);
    assert.equal(plan.atomic, true);

    const result = await connector.write({ connection }, { ...request, final: true }, [
      { rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }], cursor: { offset: 2 } }
    ]);
    assert.equal(result.committedRows, 2);

    const verification = await connector.verify({ connection }, { resource: 'out/customers.jsonl', expectedRows: 2 });
    assert.equal(verification.ok, true);
    assert.equal(verification.targetRows, 2);
    assert.match(verification.sha256, /^sha256:[a-f0-9]{64}$/);

    const text = await readFile(join(root, 'out', 'customers.jsonl'), 'utf8');
    assert.match(text, /"Ada"/);
    const names = await readdir(join(root, 'out'));
    assert.deepEqual(names, ['customers.jsonl']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filesystem connector supports hardened CSV and JSON source formats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spool-fs-'));
  try {
    await writeFile(join(root, 'customers.csv'), 'id,name\r\n1,"Ada, A."\r\n2,Grace\r\n');
    await writeFile(join(root, 'customers.json'), JSON.stringify([{ id: 3, name: 'Linus' }]));
    const connector = new FilesystemConnector({ root });
    const connection = await connector.validateConfig({ root });

    const csvRows = [];
    for await (const batch of connector.read({ connection }, { resource: 'customers.csv', batchSize: 50 })) csvRows.push(...batch.rows);
    assert.equal(csvRows[0].name, 'Ada, A.');

    const jsonRows = [];
    for await (const batch of connector.read({ connection }, { resource: 'customers.json', batchSize: 50 })) jsonRows.push(...batch.rows);
    assert.deepEqual(jsonRows, [{ id: 3, name: 'Linus' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
