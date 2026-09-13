import test from 'node:test';
import assert from 'node:assert/strict';
import { POSTGRES_SOURCE_DESCRIPTOR } from '../src/connectors/postgres/source.js';

test('PostgreSQL source advertises durable materialization capability', () => {
  assert.equal(POSTGRES_SOURCE_DESCRIPTOR.capabilities.durableMaterialization, true);
});
