import { fail } from './errors.js';

const OPS = new Set([
  'field', 'literal', 'copy', 'trim', 'lowercase', 'uppercase', 'split', 'join', 'coalesce',
  'cast_string', 'cast_number', 'cast_boolean', 'parse_date', 'format_date', 'regex_replace',
  'enum_map', 'multiply', 'divide', 'round', 'concat', 'conditional'
]);

function isUnsafeRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 256) return true;
  // Conservative nested-quantifier and repeated-wildcard guard against common catastrophic patterns.
  return /\((?:[^()]|\\.)*[+*](?:[^()]|\\.)*\)[+*{]/.test(pattern) || /(\.\*){2,}|(\.\+){2,}/.test(pattern);
}

export function validateExpr(expr, options = {}, depth = 0) {
  const maxDepth = options.maxDepth ?? 20;
  if (depth > maxDepth) fail('EXPR_TOO_DEEP', `Expression depth exceeds ${maxDepth}`);
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) fail('INVALID_EXPR', 'Transform expression must be an object');
  if (!OPS.has(expr.op)) fail('UNKNOWN_OPERATOR', `Unknown operator ${expr.op}`);
  const child = value => validateExpr(value, options, depth + 1);
  switch (expr.op) {
    case 'field':
    case 'copy':
      if (typeof expr.name !== 'string' || !expr.name) fail('INVALID_FIELD', 'field/copy requires a name');
      break;
    case 'literal': break;
    case 'trim': case 'lowercase': case 'uppercase': case 'cast_string': case 'cast_number': case 'cast_boolean': case 'parse_date': case 'round':
      child(expr.value); break;
    case 'format_date':
      child(expr.value); if (typeof expr.format !== 'string') fail('INVALID_FORMAT', 'format_date requires format'); break;
    case 'regex_replace':
      child(expr.value); if (isUnsafeRegex(expr.pattern)) fail('UNSAFE_REGEX', 'Regex pattern rejected by safety policy'); break;
    case 'enum_map':
      child(expr.value); if (!expr.map || typeof expr.map !== 'object' || Array.isArray(expr.map)) fail('INVALID_ENUM_MAP', 'enum_map requires an object map'); break;
    case 'multiply': case 'divide':
      child(expr.left); child(expr.right); break;
    case 'split':
      child(expr.value); if (typeof expr.separator !== 'string') fail('INVALID_SEPARATOR', 'split requires separator'); break;
    case 'join':
      if (!Array.isArray(expr.values)) fail('INVALID_VALUES', 'join requires values'); expr.values.forEach(child); break;
    case 'coalesce': case 'concat':
      if (!Array.isArray(expr.values) || expr.values.length === 0) fail('INVALID_VALUES', `${expr.op} requires values`); expr.values.forEach(child); break;
    case 'conditional':
      child(expr.if); child(expr.then); child(expr.else); break;
    default: break;
  }
  return expr;
}

const asNumber = value => {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) fail('INVALID_NUMBER', `Cannot convert ${String(value)} to number`);
  return n;
};

export function evaluateExpr(expr, row) {
  switch (expr.op) {
    case 'field': case 'copy': return row?.[expr.name];
    case 'literal': return expr.value;
    case 'trim': return String(evaluateExpr(expr.value, row) ?? '').trim();
    case 'lowercase': return String(evaluateExpr(expr.value, row) ?? '').toLowerCase();
    case 'uppercase': return String(evaluateExpr(expr.value, row) ?? '').toUpperCase();
    case 'cast_string': return String(evaluateExpr(expr.value, row) ?? '');
    case 'cast_number': return asNumber(evaluateExpr(expr.value, row));
    case 'cast_boolean': {
      const v = String(evaluateExpr(expr.value, row) ?? '').trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(v)) return true;
      if (['false', '0', 'no', 'n'].includes(v)) return false;
      fail('INVALID_BOOLEAN', `Cannot convert ${v} to boolean`);
    }
    case 'parse_date': {
      const v = evaluateExpr(expr.value, row); const d = new Date(v);
      if (Number.isNaN(d.valueOf())) fail('INVALID_DATE', `Cannot parse ${String(v)} as date`);
      return d.toISOString();
    }
    case 'format_date': {
      const d = new Date(evaluateExpr(expr.value, row));
      if (Number.isNaN(d.valueOf())) fail('INVALID_DATE', 'Cannot format invalid date');
      if (expr.format === 'YYYY-MM-DD') return d.toISOString().slice(0, 10);
      if (expr.format === 'ISO') return d.toISOString();
      fail('UNSUPPORTED_DATE_FORMAT', `Unsupported date format ${expr.format}`);
    }
    case 'regex_replace': return String(evaluateExpr(expr.value, row) ?? '').replace(new RegExp(expr.pattern, expr.flags ?? 'g'), expr.replacement ?? '');
    case 'enum_map': {
      const key = String(evaluateExpr(expr.value, row));
      if (!Object.hasOwn(expr.map, key)) fail('UNMAPPED_ENUM', `No enum mapping for ${key}`);
      return expr.map[key];
    }
    case 'multiply': return asNumber(evaluateExpr(expr.left, row)) * asNumber(evaluateExpr(expr.right, row));
    case 'divide': {
      const denominator = asNumber(evaluateExpr(expr.right, row));
      if (denominator === 0) fail('DIVIDE_BY_ZERO', 'Division by zero');
      return asNumber(evaluateExpr(expr.left, row)) / denominator;
    }
    case 'round': return Math.round(asNumber(evaluateExpr(expr.value, row)));
    case 'split': return String(evaluateExpr(expr.value, row) ?? '').split(expr.separator);
    case 'join': return expr.values.map(v => evaluateExpr(v, row)).join(expr.separator ?? '');
    case 'coalesce': {
      for (const item of expr.values) { const v = evaluateExpr(item, row); if (v !== null && v !== undefined && v !== '') return v; }
      return null;
    }
    case 'concat': return expr.values.map(v => String(evaluateExpr(v, row) ?? '')).join('');
    case 'conditional': return evaluateExpr(expr.if, row) ? evaluateExpr(expr.then, row) : evaluateExpr(expr.else, row);
    default: fail('UNKNOWN_OPERATOR', `Unknown operator ${expr.op}`);
  }
}

export function compileMapping(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) fail('EMPTY_MAPPING', 'Mapping requires at least one target');
  const seen = new Set();
  const normalized = entries.map(entry => {
    if (!entry || typeof entry.target !== 'string' || !entry.target) fail('INVALID_TARGET', 'Mapping target must be a non-empty string');
    if (seen.has(entry.target)) fail('DUPLICATE_TARGET', `Duplicate mapping target ${entry.target}`);
    seen.add(entry.target);
    validateExpr(entry.expr, options);
    return structuredClone(entry);
  });
  return {
    entries: normalized,
    targets: normalized.map(x => x.target),
    mapRow(row) {
      const out = Object.create(null);
      for (const entry of normalized) out[entry.target] = evaluateExpr(entry.expr, row);
      return { ...out };
    }
  };
}
