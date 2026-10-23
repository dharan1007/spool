// Deterministic plan construction for the Console wizard.
//
// The wizard collects intent (source, destination, target schema, mapping) and
// this module turns it into the engine's canonical plan input. It uses only the
// engine's allow-listed transformation operators and the engine's own plan
// identity algorithm. No generated code, no SQL expressions, no heuristics that
// differ from the engine.
import { consoleFail } from './errors.js';

export const OPERATOR_VERSION = 'spool-operators-v1';

const CAST_FOR_TYPE = {
  integer: 'cast_number',
  number: 'cast_number',
  boolean: 'cast_boolean',
  date: 'parse_date',
  local_datetime: 'parse_local_datetime',
  string: 'trim'
};

export function defaultMapping(sourceHeaders, targetSchema) {
  const available = new Set(sourceHeaders);
  const mapping = [];
  for (const field of targetSchema) {
    const source = sourceHeaders.find(header => header === field.name)
      ?? sourceHeaders.find(header => normalise(header) === normalise(field.name));
    if (!source) continue;
    mapping.push({ target: field.name, expr: transformFor(field.type, { op: 'field', name: source }) });
  }
  return mapping;
}

export function transformFor(targetType, expr) {
  const op = CAST_FOR_TYPE[targetType];
  if (!op) consoleFail('CONSOLE_VALIDATION_FAILED', `Unsupported target type ${targetType}`);
  if (op === 'trim' && expr.op === 'trim') return expr;
  return { op, value: expr };
}

export function normalise(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function validateMapping({ engine, mapping, targetSchema, sourceHeaders = [] }) {
  try {
    engine.compileMapping(mapping);
  } catch (error) {
    return {
      valid: false,
      problems: [{ code: error?.code ?? 'INVALID_MAPPING', message: stripCode(error?.message) }],
      unmappedTargets: [],
      unusedSourceFields: [],
      duplicateTargets: []
    };
  }
  const targets = mapping.map(entry => entry.target);
  const targetNames = new Set(targetSchema.map(field => field.name));
  const mapped = new Set(targets);
  const duplicateTargets = targets.filter((name, index) => targets.indexOf(name) !== index);
  const unknownTargets = targets.filter(name => !targetNames.has(name));
  const unmappedTargets = targetSchema.filter(field => !mapped.has(field.name)).map(field => field.name);
  const referenced = new Set();
  for (const entry of mapping) collectFields(entry.expr, referenced);
  const unusedSourceFields = sourceHeaders.filter(header => !referenced.has(header));

  const problems = [];
  if (duplicateTargets.length) problems.push({ code: 'DUPLICATE_TARGET', message: 'A target column is mapped more than once', fields: [...new Set(duplicateTargets)] });
  if (unknownTargets.length) problems.push({ code: 'UNKNOWN_TARGET', message: 'The mapping references target columns that are not in the target schema', fields: unknownTargets });
  if (unmappedTargets.length) problems.push({ code: 'UNMAPPED_TARGET', message: 'Some target columns have no mapping', fields: unmappedTargets });
  const unknownSources = [...referenced].filter(name => sourceHeaders.length > 0 && !sourceHeaders.includes(name));
  if (unknownSources.length) problems.push({ code: 'UNKNOWN_SOURCE', message: 'The mapping references source columns that do not exist', fields: unknownSources });

  return {
    valid: problems.length === 0,
    problems,
    unmappedTargets,
    unusedSourceFields,
    duplicateTargets: [...new Set(duplicateTargets)],
    unknownTargets,
    unknownSourceFields: unknownSources
  };
}

function collectFields(expr, into) {
  if (!expr || typeof expr !== 'object') return;
  if (typeof expr.name === 'string' && (expr.op === 'field' || expr.op === 'copy')) into.add(expr.name);
  for (const value of Object.values(expr)) {
    if (Array.isArray(value)) value.forEach(item => collectFields(item, into));
    else if (value && typeof value === 'object') collectFields(value, into);
  }
}

export function buildPlanInput({ sourceProfile, destination, mapping, mappingRevision, planRevision, batchSize }) {
  return {
    planRevision,
    sourceRef: {
      connector: 'filesystem',
      connectionId: `console-source:${sourceProfile.sourceFingerprint.slice(7, 19)}`,
      resource: sourceProfile.name,
      path: sourceProfile.path
    },
    targetRef: {
      connector: 'sqlite',
      connectionId: `console-target:${destination.targetContractId.slice(7, 19)}`,
      resource: destination.table,
      path: destination.path,
      table: destination.table
    },
    targetSchema: destination.targetSchema,
    mapping,
    mappingRevision,
    writeStrategy: { mode: 'insert', batchSize },
    // `content_exact` is intentionally absent: the qualified SQLite runtime does
    // not implement read-after-write content verification. Claiming it here would
    // overstate what the receipt proves.
    verification: { checks: ['row_accounting', 'ledger_complete'] },
    risk: { level: 'medium', approvals: ['target_write'] },
    capabilityAssumptions: {
      source: { snapshotBinding: true },
      target: {
        transactions: true,
        atomicBatchLedger: true,
        reconcileAfterCrash: true,
        idempotentReplay: true,
        fencing: true
      }
    }
  };
}

export function schemaSignature(engine, targetSchema) {
  const normalised = targetSchema
    .map(field => ({ name: field.name, type: field.type, nullable: Boolean(field.nullable) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return engine.sha256Canonical('spool-console-recipe-schema-v1', normalised);
}

export function stripCode(message) {
  if (typeof message !== 'string') return 'Validation failed';
  return message.replace(/^[A-Z_]+:\s*/, '');
}
