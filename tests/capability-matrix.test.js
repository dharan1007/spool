import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { renderCapabilityDocs } from '../scripts/build-capability-docs.js';
import { SQLITE_TARGET_DESCRIPTOR } from '../src/connectors/sqlite/runtime.js';
import { POSTGRES_SOURCE_DESCRIPTOR } from '../src/connectors/postgres/source.js';
import { POSTGRES_TARGET_DESCRIPTOR } from '../src/connectors/postgres/runtime.js';
import { MYSQL_SOURCE_DESCRIPTOR } from '../src/connectors/mysql/source.js';
import { MYSQL_TARGET_DESCRIPTOR } from '../src/connectors/mysql/runtime.js';
import { MSSQL_SOURCE_DESCRIPTOR } from '../src/connectors/mssql/source.js';
import { MSSQL_TARGET_DESCRIPTOR } from '../src/connectors/mssql/runtime.js';

const EVIDENCE_KEYS = ['implementation', 'integrationTests', 'faultTests', 'securityTests', 'loadTests', 'benchmarks', 'limits'];

async function matrix() {
  return JSON.parse(await readFile(new URL('../capabilities/matrix.json', import.meta.url), 'utf8'));
}

test('capability matrix is well-formed with unique ids and valid statuses', async () => {
  const data = await matrix();
  assert.deepEqual(data.statuses, ['PRODUCTION', 'EXPERIMENTAL', 'PLANNED', 'UNSUPPORTED']);
  const ids = data.capabilities.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of data.capabilities) {
    assert.ok(data.statuses.includes(item.status), `invalid status for ${item.id}`);
    assert.equal(typeof item.label, 'string');
    assert.ok(item.notes.length > 10, `missing rationale for ${item.id}`);
  }
});

test('capability matrix matches the connector descriptors in code', async () => {
  const data = await matrix();
  const byId = new Map(data.capabilities.map(item => [item.id, item]));
  for (const descriptor of [
    SQLITE_TARGET_DESCRIPTOR,
    POSTGRES_SOURCE_DESCRIPTOR, POSTGRES_TARGET_DESCRIPTOR,
    MYSQL_SOURCE_DESCRIPTOR, MYSQL_TARGET_DESCRIPTOR,
    MSSQL_SOURCE_DESCRIPTOR, MSSQL_TARGET_DESCRIPTOR
  ]) {
    const id = `${descriptor.name}.${descriptor.role}`;
    const row = byId.get(id);
    assert.ok(row, `matrix is missing connector ${id}`);
    assert.ok(['PRODUCTION', 'EXPERIMENTAL'].includes(row.status), `${id} must be shipped, not planned`);
    assert.equal(row.assurance, descriptor.assurance.level);
  }
});

test('capability evidence satisfies the production rule and every cited file exists', async () => {
  const data = await matrix();
  for (const item of data.capabilities) {
    const evidence = item.evidence ?? {};
    if (item.status === 'PRODUCTION') {
      for (const key of EVIDENCE_KEYS) {
        const value = evidence[key];
        const present = Array.isArray(value) ? value.length > 0 : Boolean(value);
        assert.ok(present, `${item.id} claims PRODUCTION without ${key}`);
      }
    }
    if (item.status === 'EXPERIMENTAL') {
      assert.ok((evidence.implementation ?? []).length > 0, `${item.id} has no implementation`);
      assert.ok((evidence.integrationTests ?? []).length > 0, `${item.id} has no integration test`);
    }
    if (item.status === 'PLANNED' || item.status === 'UNSUPPORTED') {
      const claimed = Object.values(evidence).filter(value => (Array.isArray(value) ? value.length > 0 : Boolean(value)));
      assert.equal(claimed.length, 0, `${item.id} claims evidence for an unshipped status`);
    }
    for (const key of ['implementation', 'integrationTests', 'faultTests', 'securityTests', 'loadTests']) {
      for (const file of evidence[key] ?? []) {
        assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${item.id} cites missing evidence ${file}`);
      }
    }
    if (typeof evidence.limits === 'string') {
      const [file] = evidence.limits.split('#');
      assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${item.id} cites missing limits ${evidence.limits}`);
    }
    for (const file of evidence.benchmarks ?? []) {
      if (file.endsWith('.js')) assert.ok(existsSync(new URL(`../${file.split(' ')[0]}`, import.meta.url)), `${item.id} cites missing benchmark ${file}`);
    }
  }
});

test('capability docs are freshly generated from the matrix', async () => {
  const data = await matrix();
  const rendered = renderCapabilityDocs(data);
  const checkedIn = (await readFile(new URL('../docs/CAPABILITIES.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(checkedIn, rendered);
});


test('PostgreSQL source remains experimental without exact-release live qualification', async () => {
  const data = await matrix();
  const source = data.capabilities.find(item => item.id === 'postgres.source');
  assert.equal(source.status, 'EXPERIMENTAL');
  assert.match(source.notes, /not been independently reproduced and SHA-bound/);
});
