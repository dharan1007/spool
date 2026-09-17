import test from 'node:test';
import assert from 'node:assert/strict';
import { diffPostgresSchema, createSchemaMigrationPlan } from '../src/connectors/postgres/schema-migration.js';

const CONTRACT = `sha256:${'a'.repeat(64)}`;

function liveRecord({ columns, pk = ['id'], extras = {} } = {}) {
  return {
    columns,
    indexes: pk.length
      ? [{ name: 't_pkey', unique: true, primary: true, valid: true, ready: true, definition: `CREATE UNIQUE INDEX t_pkey ON public.t USING btree (${pk.map(name => `"${name}"`).join(', ')})` }]
      : [],
    constraints: pk.length ? [{ name: 't_pkey', type: 'p', validated: true, deferrable: false, deferred: false, definition: `PRIMARY KEY (${pk.join(', ')})` }] : [],
    triggers: [],
    rules: [],
    ...extras
  };
}

function column(name, pgType, { notNull = false, formattedType = null } = {}) {
  return { ordinal: 1, name, pgType, formattedType: formattedType ?? pgType, notNull, identity: '', generated: '', defaultSql: null };
}

const BASE_COLUMNS = [column('id', 'int4', { notNull: true }), column('name', 'text')];
const BASE_DESIRED = [
  { name: 'id', type: 'integer', nullable: false },
  { name: 'name', type: 'string', nullable: true }
];

test('identical desired and live shapes produce an empty diff', () => {
  const diff = diffPostgresSchema({ desiredSchema: BASE_DESIRED, primaryKey: ['id'], liveRecord: liveRecord({ columns: BASE_COLUMNS }) });
  assert.deepEqual(diff, []);
});

test('added columns classify nullable as online and required as blocking', () => {
  const desired = [...BASE_DESIRED, { name: 'nick', type: 'string', nullable: true }, { name: 'score', type: 'integer', nullable: false }];
  const diff = diffPostgresSchema({ desiredSchema: desired, primaryKey: ['id'], liveRecord: liveRecord({ columns: BASE_COLUMNS }) });
  assert.deepEqual(diff.map(entry => [entry.kind, entry.column, entry.safety]), [
    ['ADD_COLUMN', 'nick', 'ONLINE'],
    ['ADD_COLUMN', 'score', 'BLOCKING']
  ]);
});

test('dropped columns are destructive', () => {
  const diff = diffPostgresSchema({
    desiredSchema: [{ name: 'id', type: 'integer', nullable: false }],
    primaryKey: ['id'],
    liveRecord: liveRecord({ columns: BASE_COLUMNS })
  });
  assert.deepEqual(diff.map(entry => [entry.kind, entry.column, entry.safety]), [['DROP_COLUMN', 'name', 'DESTRUCTIVE']]);
});

test('total casts to text block while lossy casts are destructive', () => {
  const toText = diffPostgresSchema({
    desiredSchema: [{ name: 'id', type: 'integer', nullable: false }, { name: 'code', type: 'string', nullable: true }],
    primaryKey: ['id'],
    liveRecord: liveRecord({ columns: [column('id', 'int4', { notNull: true }), column('code', 'int4')] })
  });
  assert.deepEqual(toText.map(entry => [entry.kind, entry.column, entry.safety, entry.toType]), [
    ['ALTER_COLUMN_TYPE', 'code', 'BLOCKING', 'text']
  ]);

  const lossy = diffPostgresSchema({
    desiredSchema: [{ name: 'id', type: 'number', nullable: false }],
    primaryKey: ['id'],
    liveRecord: liveRecord({ columns: [column('id', 'text', { notNull: true })] })
  });
  assert.deepEqual(lossy.map(entry => [entry.kind, entry.column, entry.safety]), [['ALTER_COLUMN_TYPE', 'id', 'DESTRUCTIVE']]);
});

test('nullability convergence emits set and drop steps', () => {
  const diff = diffPostgresSchema({
    desiredSchema: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'name', type: 'string', nullable: false },
      { name: 'note', type: 'string', nullable: true }
    ],
    primaryKey: ['id'],
    liveRecord: liveRecord({ columns: [column('id', 'int4', { notNull: true }), column('name', 'text'), column('note', 'text', { notNull: true })] })
  });
  assert.deepEqual(diff.map(entry => [entry.kind, entry.column, entry.safety]), [
    ['SET_NOT_NULL', 'name', 'BLOCKING'],
    ['DROP_NOT_NULL', 'note', 'ONLINE']
  ]);
});

test('primary-key changes emit ordered drop and add steps', () => {
  const diff = diffPostgresSchema({
    desiredSchema: BASE_DESIRED,
    primaryKey: ['id', 'name'],
    liveRecord: liveRecord({ columns: BASE_COLUMNS })
  });
  assert.deepEqual(diff.map(entry => [entry.kind, entry.safety]), [['PK_DROP', 'BLOCKING'], ['PK_ADD', 'BLOCKING']]);
  assert.deepEqual(diff[1].columns, ['id', 'name']);
});

test('unmanaged objects are reported and refuse plan creation', () => {
  const record = liveRecord({
    columns: BASE_COLUMNS,
    extras: { indexes: [
      { name: 't_pkey', unique: true, primary: true, valid: true, ready: true, definition: 'CREATE UNIQUE INDEX t_pkey ON public.t USING btree ("id")' },
      { name: 't_name_idx', unique: false, primary: false, valid: true, ready: true, definition: 'CREATE INDEX t_name_idx ON public.t USING btree (name)' }
    ] }
  });
  const diff = diffPostgresSchema({ desiredSchema: BASE_DESIRED, primaryKey: ['id'], liveRecord: record });
  assert.deepEqual(diff.map(entry => entry.kind), ['UNMANAGED_INDEX']);
  assert.throws(() => createSchemaMigrationPlan({
    migrationId: 'mig_001', targetIdentity: { connector: 'postgres' }, fromContractId: CONTRACT,
    desiredSchema: BASE_DESIRED, primaryKey: ['id'], diff
  }), /SCHEMA_MIGRATION_UNMANAGED/);
});

test('migration plans order steps deterministically with stable hash identity', () => {
  const desired = [
    { name: 'id', type: 'integer', nullable: false },
    { name: 'renamed', type: 'string', nullable: true }
  ];
  const diff = diffPostgresSchema({
    desiredSchema: desired,
    primaryKey: ['renamed'],
    liveRecord: liveRecord({ columns: BASE_COLUMNS })
  });
  assert.deepEqual(diff.map(entry => entry.kind), ['PK_DROP', 'DROP_COLUMN', 'ADD_COLUMN', 'PK_ADD']);
  const plan = createSchemaMigrationPlan({
    migrationId: 'mig_plan_001',
    targetIdentity: { connector: 'postgres', connectionId: 'c', resource: 'public.t' },
    fromContractId: CONTRACT,
    desiredSchema: desired,
    primaryKey: ['renamed'],
    diff
  });
  assert.deepEqual(plan.steps.map(step => step.kind), ['PK_DROP', 'DROP_COLUMN', 'ADD_COLUMN', 'PK_ADD']);
  assert.deepEqual(plan.steps.map(step => step.stepId), [1, 2, 3, 4]);
  assert.equal(plan.requiresDestructiveApproval, true);
  assert.match(plan.planId, /^sha256:[0-9a-f]{64}$/);
  const again = createSchemaMigrationPlan({
    migrationId: 'mig_plan_001',
    targetIdentity: { connector: 'postgres', connectionId: 'c', resource: 'public.t' },
    fromContractId: CONTRACT,
    desiredSchema: desired,
    primaryKey: ['renamed'],
    diff
  });
  assert.equal(again.planId, plan.planId);
});

test('online-only plans do not require destructive approval', () => {
  const desired = [...BASE_DESIRED, { name: 'nick', type: 'string', nullable: true }];
  const diff = diffPostgresSchema({ desiredSchema: desired, primaryKey: ['id'], liveRecord: liveRecord({ columns: BASE_COLUMNS }) });
  const plan = createSchemaMigrationPlan({
    migrationId: 'mig_plan_002',
    targetIdentity: { connector: 'postgres' },
    fromContractId: CONTRACT,
    desiredSchema: desired,
    primaryKey: ['id'],
    diff
  });
  assert.equal(plan.requiresDestructiveApproval, false);
});

test('plan creation rejects empty diffs and invalid inputs', () => {
  const build = diff => createSchemaMigrationPlan({
    migrationId: 'mig_plan_003', targetIdentity: { connector: 'postgres' }, fromContractId: CONTRACT,
    desiredSchema: BASE_DESIRED, primaryKey: ['id'], diff
  });
  assert.throws(() => build([]), /SCHEMA_MIGRATION_EMPTY/);
  assert.throws(() => build([{ kind: 'ADD_COLUMN' }]), /INVALID_SCHEMA_MIGRATION_INPUT/);
  assert.throws(() => build([{ kind: 'TELEPORT_COLUMN', safety: 'ONLINE' }]), /INVALID_SCHEMA_MIGRATION_INPUT/);
  assert.throws(() => createSchemaMigrationPlan({
    migrationId: '', targetIdentity: { connector: 'postgres' }, fromContractId: CONTRACT,
    desiredSchema: BASE_DESIRED, primaryKey: ['id'],
    diff: [{ kind: 'ADD_COLUMN', column: 'x', safety: 'ONLINE' }]
  }), /INVALID_SCHEMA_MIGRATION_INPUT/);
  assert.throws(() => diffPostgresSchema({ desiredSchema: BASE_DESIRED, primaryKey: ['nope'], liveRecord: liveRecord({ columns: BASE_COLUMNS }) }), /INVALID_SCHEMA_MIGRATION_INPUT/);
  assert.throws(() => diffPostgresSchema({ desiredSchema: [{ name: 'id', type: 'integer' }], primaryKey: ['id'], liveRecord: liveRecord({ columns: BASE_COLUMNS }) }), /INVALID_SCHEMA_MIGRATION_INPUT/);
});
