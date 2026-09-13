import { fail } from '../core/errors.js';

const HASH = /^sha256:[a-f0-9]{64}$/;

function text(name, value, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_REPAIR_EXECUTION', `${name} must be a non-empty bounded string`);
  return value;
}

function hash(name, value) {
  text(name, value);
  if (!HASH.test(value)) fail('INVALID_REPAIR_EXECUTION', `${name} must be a canonical sha256 identity`);
  return value;
}

function requirePlans(plans) {
  if (!Array.isArray(plans) || plans.length === 0) fail('INVALID_REPAIR_EXECUTION', 'repair plans must be a non-empty array');
  return plans.map((plan, index) => {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('INVALID_REPAIR_EXECUTION', `repair plan ${index} must be an object`);
    hash(`repair plan ${index} repairPlanId`, plan.repairPlanId);
    if (!Array.isArray(plan.primaryKey) || plan.primaryKey.length === 0) fail('INVALID_REPAIR_EXECUTION', `repair plan ${index} primaryKey is required`);
    if (!Array.isArray(plan.columns) || plan.columns.length === 0) fail('INVALID_REPAIR_EXECUTION', `repair plan ${index} columns are required`);
    if (!Array.isArray(plan.operations) || plan.operations.length === 0) fail('INVALID_REPAIR_EXECUTION', `repair plan ${index} operations must be a non-empty array`);
    return plan;
  });
}

function requireProgress(progress) {
  if (!progress || typeof progress !== 'object') fail('INVALID_REPAIR_EXECUTION', 'repair progress ledger is required');
  if (typeof progress.loadOperation !== 'function' || typeof progress.saveOperation !== 'function') {
    fail('INVALID_REPAIR_EXECUTION', 'repair progress ledger must implement loadOperation/saveOperation');
  }
  return progress;
}

export async function executeRepairOperations({ plans, target, targetSchema, fencingToken, targetContractId, progress } = {}) {
  const repairPlans = requirePlans(plans);
  if (!target || typeof target.applyRepairOperation !== 'function') fail('INVALID_REPAIR_EXECUTION', 'repair target must implement applyRepairOperation');
  if (!Array.isArray(targetSchema) || targetSchema.length === 0) fail('INVALID_REPAIR_EXECUTION', 'targetSchema is required for repair execution');
  const ledger = requireProgress(progress);

  const results = [];
  for (const plan of repairPlans) {
    for (const operation of plan.operations) {
      const keyId = operation?.keyId;
      const stored = keyId == null ? null : await ledger.loadOperation(plan.repairPlanId, keyId);
      if (stored?.applied === true) {
        results.push(Object.freeze({
          repairPlanId: plan.repairPlanId,
          keyId,
          effect: stored.effect,
          applied: false,
          resumed: true,
          observedRowHash: stored.observedRowHash ?? null,
          writtenRowHash: stored.writtenRowHash ?? null
        }));
        continue;
      }
      const applied = await target.applyRepairOperation({
        operation,
        primaryKey: plan.primaryKey,
        targetSchema,
        fencingToken,
        targetContractId
      });
      const recorded = {
        repairPlanId: plan.repairPlanId,
        keyId: applied.keyId,
        effect: applied.effect,
        applied: applied.applied,
        observedRowHash: applied.observedRowHash,
        writtenRowHash: applied.writtenRowHash,
        attemptedAt: new Date().toISOString()
      };
      await ledger.saveOperation(recorded);
      results.push(Object.freeze({ ...recorded, resumed: false }));
    }
  }
  return Object.freeze(results);
}

export function summarizeRepairOperations(results = {}) {
  const list = Array.isArray(results) ? results : [];
  const counts = { insert: 0, update: 0, delete: 0, alreadyApplied: 0 };
  for (const item of list) {
    if (item?.resumed === true || item?.applied !== true) {
      counts.alreadyApplied += 1;
      continue;
    }
    if (item.effect === 'INSERT') counts.insert += 1;
    else if (item.effect === 'UPDATE') counts.update += 1;
    else if (item.effect === 'DELETE') counts.delete += 1;
  }
  return Object.freeze(counts);
}
