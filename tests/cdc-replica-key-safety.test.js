import test from 'node:test';
import assert from 'node:assert/strict';
import { expressionSourceFields } from '../src/core/transforms.js';
import { assertCdcTargetKeyReplicaSafe } from '../src/connectors/postgres/cdc.js';

const identityMapping = [
  { target: 'id', expr: { op: 'field', name: 'id' } },
  { target: 'payload', expr: { op: 'field', name: 'payload' } }
];

test('transform dependency analysis is structural across nested branches', () => {
  const fields = expressionSourceFields({
    op: 'conditional',
    if: { op: 'field', name: 'use_region' },
    then: {
      op: 'concat',
      values: [
        { op: 'field', name: 'tenant_id' },
        { op: 'literal', value: ':' },
        { op: 'field', name: 'region' }
      ]
    },
    else: {
      op: 'coalesce',
      values: [
        { op: 'field', name: 'legacy_id' },
        { op: 'field', name: 'tenant_id' }
      ]
    }
  });
  assert.deepEqual(fields, ['legacy_id', 'region', 'tenant_id', 'use_region']);
});

test('DEFAULT replica identity accepts target key derived only from source identity columns', () => {
  const result = assertCdcTargetKeyReplicaSafe({
    mapping: identityMapping,
    targetPrimaryKey: ['id'],
    replicaIdentity: {
      mode: 'DEFAULT',
      columns: ['id'],
      schema: 'public',
      table: 'src'
    }
  });
  assert.equal(result.safe, true);
  assert.deepEqual(result.replicaIdentityColumns, ['id']);
  assert.deepEqual(result.dependencies.id, ['id']);
});

test('explicit replica identity index accepts composite target-key dependencies covered by the index', () => {
  const mapping = [
    {
      target: 'tenant_key',
      expr: {
        op: 'concat',
        values: [
          { op: 'field', name: 'tenant_id' },
          { op: 'literal', value: ':' },
          { op: 'field', name: 'source_id' }
        ]
      }
    }
  ];
  const result = assertCdcTargetKeyReplicaSafe({
    mapping,
    targetPrimaryKey: ['tenant_key'],
    replicaIdentity: {
      mode: 'INDEX',
      columns: ['tenant_id', 'source_id'],
      schema: 'public',
      table: 'src'
    }
  });
  assert.equal(result.safe, true);
});

test('derived target key using non-replica source field fails closed', () => {
  const mapping = [
    {
      target: 'id',
      expr: {
        op: 'concat',
        values: [
          { op: 'field', name: 'id' },
          { op: 'literal', value: ':' },
          { op: 'field', name: 'region' }
        ]
      }
    }
  ];
  assert.throws(
    () => assertCdcTargetKeyReplicaSafe({
      mapping,
      targetPrimaryKey: ['id'],
      replicaIdentity: {
        mode: 'DEFAULT',
        columns: ['id'],
        schema: 'public',
        table: 'src'
      }
    }),
    error => error?.code === 'CDC_TARGET_KEY_NOT_REPLICA_SAFE'
      && error?.details?.unsafeDependencies?.some(item => item.sourceField === 'region')
  );
});

test('REPLICA IDENTITY FULL permits target keys derived from any source fields', () => {
  const mapping = [
    {
      target: 'id',
      expr: {
        op: 'concat',
        values: [
          { op: 'field', name: 'id' },
          { op: 'field', name: 'region' }
        ]
      }
    }
  ];
  const result = assertCdcTargetKeyReplicaSafe({
    mapping,
    targetPrimaryKey: ['id'],
    replicaIdentity: {
      mode: 'FULL',
      columns: [],
      schema: 'public',
      table: 'src'
    }
  });
  assert.equal(result.safe, true);
  assert.equal(result.mode, 'FULL');
});

test('REPLICA IDENTITY NOTHING is refused for UPDATE/DELETE CDC', () => {
  assert.throws(
    () => assertCdcTargetKeyReplicaSafe({
      mapping: identityMapping,
      targetPrimaryKey: ['id'],
      replicaIdentity: {
        mode: 'NOTHING',
        columns: [],
        schema: 'public',
        table: 'src'
      }
    }),
    error => error?.code === 'CDC_REPLICA_IDENTITY_UNUSABLE'
  );
});

test('missing target primary-key mapping is refused before CDC starts', () => {
  assert.throws(
    () => assertCdcTargetKeyReplicaSafe({
      mapping: [{ target: 'payload', expr: { op: 'field', name: 'payload' } }],
      targetPrimaryKey: ['id'],
      replicaIdentity: {
        mode: 'DEFAULT',
        columns: ['id'],
        schema: 'public',
        table: 'src'
      }
    }),
    error => error?.code === 'CDC_TARGET_KEY_MAPPING_MISSING'
  );
});
