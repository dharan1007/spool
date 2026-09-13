import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRepairOperations, summarizeRepairOperations } from '../src/execution/repair-runner.js';

const PLAN_ID = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function memoryTarget() {
  const calls = [];
  return {
    calls,
    async applyRepairOperation(input) {
      calls.push(input);
      const { operation } = input;
      return Object.freeze({
        effect: operation.effect,
        keyId: operation.keyId,
        applied: true,
        observedRowHash: operation.actualRowHash ?? null,
        writtenRowHash: operation.expectedRowHash ?? null
      });
    }
  };
}

function memoryProgress() {
  const stored = new Map();
  return {
    async loadOperation(repairPlanId, keyId) { return stored.get(`${repairPlanId}\0${keyId}`) ?? null; },
    async saveOperation(record) { stored.set(`${record.repairPlanId}\0${record.keyId}`, { ...record }); }
  };
}

const plan = (repairPlanId, operations) => ({
  repairPlanId,
  primaryKey: ['id'],
  columns: ['id', 'name'],
  operations
});

const op = (effect, keyId) => ({
  effect,
  keyId,
  key: { id: 1 },
  expectedRowHash: effect === 'DELETE' ? null : 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  actualRowHash: effect === 'INSERT' ? null : 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  row: effect === 'DELETE' ? null : { id: 1, name: 'Ada' },
  precondition: effect === 'INSERT' ? { absent: true } : { actualRowHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }
});

test('repair runner applies every operation in plan order with fencing and contract context', async () => {
  const target = memoryTarget();
  const results = await executeRepairOperations({
    plans: [plan(PLAN_ID, [op('UPDATE', 'sha256:1111111111111111111111111111111111111111111111111111111111111111'), op('DELETE', 'sha256:2222222222222222222222222222222222222222222222222222222222222222')])],
    target,
    targetSchema: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'string' }],
    fencingToken: 7,
    targetContractId: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    progress: memoryProgress()
  });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(item => item.effect), ['UPDATE', 'DELETE']);
  assert.ok(results.every(item => item.applied === true && item.resumed === false));
  assert.equal(target.calls.length, 2);
  for (const call of target.calls) {
    assert.equal(call.fencingToken, 7);
    assert.equal(call.targetContractId, 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');
    assert.deepEqual(call.primaryKey, ['id']);
  }
  assert.deepEqual(summarizeRepairOperations(results), { insert: 0, update: 1, delete: 1, alreadyApplied: 0 });
});

test('repair runner resumes without re-applying durably recorded operations', async () => {
  const target = memoryTarget();
  const progress = memoryProgress();
  const plans = [plan(PLAN_ID, [op('INSERT', 'sha256:3333333333333333333333333333333333333333333333333333333333333333')])];
  const schema = [{ name: 'id', type: 'integer' }, { name: 'name', type: 'string' }];
  const first = await executeRepairOperations({ plans, target, targetSchema: schema, fencingToken: 3, targetContractId: null, progress });
  assert.equal(first[0].applied, true);
  assert.equal(target.calls.length, 1);

  const second = await executeRepairOperations({ plans, target, targetSchema: schema, fencingToken: 3, targetContractId: null, progress });
  assert.equal(target.calls.length, 1);
  assert.equal(second[0].applied, false);
  assert.equal(second[0].resumed, true);
  assert.deepEqual(summarizeRepairOperations(second), { insert: 0, update: 0, delete: 0, alreadyApplied: 1 });
});

test('repair runner refuses invalid plans and targets without applying anything', async () => {
  const target = memoryTarget();
  for (const plans of [[], [{ repairPlanId: PLAN_ID }], 'plans']) {
    await assert.rejects(
      () => executeRepairOperations({ plans, target, targetSchema: [{ name: 'id', type: 'integer' }], fencingToken: 1, targetContractId: null, progress: memoryProgress() }),
      /INVALID_REPAIR_EXECUTION/
    );
  }
  assert.equal(target.calls.length, 0);
  await assert.rejects(
    () => executeRepairOperations({ plans: [plan(PLAN_ID, [op('INSERT', 'sha256:4444444444444444444444444444444444444444444444444444444444444444')])], target: {}, targetSchema: [{ name: 'id', type: 'integer' }], fencingToken: 1, targetContractId: null, progress: memoryProgress() }),
    /INVALID_REPAIR_EXECUTION/
  );
});
