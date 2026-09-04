const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;

export const AUTOPILOT_OUTCOMES = Object.freeze({
  DATABASE_READY: 'database_ready',
  CLEAN_STANDARDIZE: 'clean_standardize',
  PRESERVE_CONTRACT: 'preserve_contract'
});

export function normalizeTargetName(name) {
  const normalized = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
  if (!normalized) return 'field';
  return /^[a-z_]/.test(normalized) ? normalized : `field_${normalized}`;
}

function nonEmptyValues(rows, field, limit = 1000) {
  const values = [];
  for (const row of rows.slice(0, limit)) {
    const text = String(row?.[field] ?? '').trim();
    if (text !== '') values.push(text);
  }
  return values;
}

function score(values, predicate) {
  if (!values.length) return { successCount: 0, sampleCount: 0, confidence: 0 };
  const successCount = values.reduce((count, value) => count + (predicate(value) ? 1 : 0), 0);
  return { successCount, sampleCount: values.length, confidence: successCount / values.length };
}

function inferPromotedType(field, rows) {
  if (field.type !== 'string') {
    return {
      type: field.type,
      confidence: 1,
      successCount: Math.min(rows.length, 1000),
      sampleCount: Math.min(rows.length, 1000),
      reason: 'source_schema'
    };
  }
  const values = nonEmptyValues(rows, field.name);
  if (values.length < 10) {
    return { type: 'string', confidence: 1, successCount: values.length, sampleCount: values.length, reason: 'insufficient_evidence' };
  }

  const candidates = [
    ['boolean', value => /^(?:true|false|yes|no|y|n|0|1)$/i.test(value)],
    ['integer', value => INTEGER.test(value) && Number.isSafeInteger(Number(value))],
    ['number', value => NUMBER.test(value) && Number.isFinite(Number(value))],
    ['date', value => ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))]
  ];
  const scored = candidates.map(([type, predicate]) => ({ type, ...score(values, predicate) }));
  const winner = scored.sort((a, b) => b.confidence - a.confidence || b.successCount - a.successCount)[0];
  if (winner.confidence >= 0.95) return { ...winner, reason: 'parseability' };
  return { type: 'string', confidence: 1, successCount: values.length, sampleCount: values.length, reason: 'preserve_string' };
}

function expressionFor(sourceField, type) {
  const field = { op: 'field', name: sourceField };
  if (type === 'integer' || type === 'number') return { op: 'cast_number', value: field };
  if (type === 'boolean') return { op: 'cast_boolean', value: field };
  if (type === 'date') return { op: 'parse_date', value: field };
  return { op: 'trim', value: field };
}

function collisionsFor(names) {
  const grouped = new Map();
  for (const entry of names) {
    const list = grouped.get(entry.targetName) ?? [];
    list.push(entry.sourceName);
    grouped.set(entry.targetName, list);
  }
  return [...grouped.entries()]
    .filter(([, sourceFields]) => sourceFields.length > 1)
    .map(([targetName, sourceFields]) => ({
      code: 'TARGET_NAME_COLLISION',
      message: `Multiple source fields normalize to ${targetName}. Choose distinct target names before execution.`,
      targetName,
      sourceFields
    }));
}

export function planAutopilot({ sourceSchema, rows, outcome = AUTOPILOT_OUTCOMES.DATABASE_READY }) {
  const schema = Array.isArray(sourceSchema) ? sourceSchema : [];
  const sourceRows = Array.isArray(rows) ? rows : [];
  const shouldNormalizeNames = outcome !== AUTOPILOT_OUTCOMES.PRESERVE_CONTRACT;
  const names = schema.map(field => ({ sourceName: field.name, targetName: shouldNormalizeNames ? normalizeTargetName(field.name) : field.name }));
  const ambiguities = collisionsFor(names);
  if (ambiguities.length) {
    return {
      outcome,
      targetSchema: [],
      mapping: [],
      evidence: [],
      ambiguities,
      needsAttention: true,
      confidence: 0
    };
  }

  const targetSchema = [];
  const mapping = [];
  const evidence = [];
  for (let index = 0; index < schema.length; index += 1) {
    const field = schema[index];
    const targetName = names[index].targetName;
    const inferred = outcome === AUTOPILOT_OUTCOMES.DATABASE_READY
      ? inferPromotedType(field, sourceRows)
      : { type: field.type, confidence: 1, successCount: Math.min(sourceRows.length, 1000), sampleCount: Math.min(sourceRows.length, 1000), reason: 'preserve_type' };
    targetSchema.push({ name: targetName, type: inferred.type, nullable: Boolean(field.nullable) });
    mapping.push({ target: targetName, expr: expressionFor(field.name, inferred.type) });
    evidence.push({
      sourceField: field.name,
      targetField: targetName,
      inferredType: inferred.type,
      confidence: Number(inferred.confidence.toFixed(4)),
      successCount: inferred.successCount,
      sampleCount: inferred.sampleCount,
      reason: inferred.reason,
      decision: 'automatic'
    });
  }
  const confidence = evidence.length ? Math.min(...evidence.map(item => item.confidence)) : 0;
  return { outcome, targetSchema, mapping, evidence, ambiguities: [], needsAttention: false, confidence };
}
