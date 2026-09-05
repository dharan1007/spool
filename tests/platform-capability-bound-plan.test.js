import test from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemConnector } from '../src/connectors/filesystem.js';
import { SQLiteConnector } from '../src/connectors/sqlite.js';
import {
  createMigrationPlan,
  createCapabilityBoundMigrationPlan,
  assertPlanConnectorCompatibility
} from '../src/platform/plan.js';

function basePlan() {
  return {
    planRevision: 1,
    sourceRef: { connector: 'filesystem', resource: 'input/customers.jsonl', identity: 'sha256:source' },
    targetRef: { connector: 'sqlite', resource: 'customers' },
    targetSchema: [{ name: 'id', type: 'integer', nullable: false }],
    mapping: [{ target: 'id', expr: { op: 'field', name: 'id' } }],
    writeStrategy: { mode: 'insert', batchSize: 500 },
    verification: { checks: ['processed_count', 'target_count'] },
    risk: { level: 'low', approvals: [] }
  };
}

function manifests() {
  return {
    sourceManifest: new FilesystemConnector({ root: '/tmp' }).manifest(),
    targetManifest: new SQLiteConnector({ database: '/tmp/spool-plan-capabilities.sqlite' }).manifest()
  };
}

test('capability-bound plan snapshots connector versions/profiles into immutable plan identity', async () => {
  const connectorSet = manifests();
  const plan = await createCapabilityBoundMigrationPlan(basePlan(), {
    ...connectorSet,
    requirements: { restartResume: false, verificationStrength: 'STANDARD' }
  });

  assert.equal(plan.connectorBinding.version, 'spool-plan-connector-binding-v1');
  assert.equal(plan.connectorBinding.source.name, 'filesystem');
  assert.equal(plan.connectorBinding.source.version, '1.0.0');
  assert.equal(plan.connectorBinding.target.name, 'sqlite');
  assert.equal(plan.connectorBinding.requirements.verificationStrength, 'STANDARD');
  assert.equal(Object.isFrozen(plan.connectorBinding.source.capabilityProfile), true);

  const changedTarget = structuredClone(connectorSet.targetManifest);
  changedTarget.version = '1.0.1';
  const changed = await createCapabilityBoundMigrationPlan(basePlan(), {
    sourceManifest: connectorSet.sourceManifest,
    targetManifest: changedTarget,
    requirements: { restartResume: false, verificationStrength: 'STANDARD' }
  });
  assert.notEqual(plan.planId, changed.planId);
});

test('restart-resume requirement fails closed when connector guarantees are insufficient', async () => {
  const connectorSet = manifests();
  await assert.rejects(
    () => createCapabilityBoundMigrationPlan(basePlan(), {
      ...connectorSet,
      requirements: { restartResume: true, verificationStrength: 'STANDARD' }
    }),
    /resume|reconcile|capabilit/i
  );
});

test('verification strength cannot exceed connector proof capability', async () => {
  const connectorSet = manifests();
  await assert.rejects(
    () => createCapabilityBoundMigrationPlan(basePlan(), {
      ...connectorSet,
      requirements: { restartResume: false, verificationStrength: 'STRONG' }
    }),
    /strong|verification|capabilit/i
  );
});

test('resume compatibility accepts exact connector contracts and rejects version/profile drift', async () => {
  const connectorSet = manifests();
  const plan = await createCapabilityBoundMigrationPlan(basePlan(), {
    ...connectorSet,
    requirements: { restartResume: false, verificationStrength: 'STANDARD' }
  });

  assert.equal(assertPlanConnectorCompatibility(plan, connectorSet), true);

  const versionDrift = structuredClone(connectorSet.targetManifest);
  versionDrift.version = '1.1.0';
  assert.throws(
    () => assertPlanConnectorCompatibility(plan, { sourceManifest: connectorSet.sourceManifest, targetManifest: versionDrift }),
    /drift|compatib|version/i
  );

  const profileDrift = structuredClone(connectorSet.sourceManifest);
  profileDrift.capabilityProfile.verification.sampleHash = true;
  assert.throws(
    () => assertPlanConnectorCompatibility(plan, { sourceManifest: profileDrift, targetManifest: connectorSet.targetManifest }),
    /drift|compatib|profile/i
  );
});

test('legacy plan constructor remains backward compatible and does not invent connector guarantees', async () => {
  const plan = await createMigrationPlan(basePlan());
  assert.equal(plan.connectorBinding, undefined);
  assert.equal(plan.identityVersion, 'spool-plan-v1');
});
