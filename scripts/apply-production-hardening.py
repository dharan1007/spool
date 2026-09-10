#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    i = text.find(start)
    if i < 0:
        raise RuntimeError(f'{label}: start marker not found')
    j = text.find(end, i)
    if j < 0:
        raise RuntimeError(f'{label}: end marker not found')
    return text[:i] + replacement + text[j:]


# 1. Deterministic temporal semantics: distinguish floating local datetime from an instant.
p = 'src/core/deterministic-date.js'
s = read(p)
s = replace_once(
    s,
    "const ISO_INSTANT = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}:?\\d{2})$/;\n",
    "const ISO_INSTANT = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}:?\\d{2})$/;\nconst LOCAL_DATETIME = /^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,9}))?)?$/;\nconst CANONICAL_LOCAL_DATETIME = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,9}))?$/;\n",
    'temporal regexes'
)
marker = "function textualMatch(text, original) {\n"
local_helpers = r'''function validateLocalDateTimeMatch(match, original) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
      || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    fail('INVALID_LOCAL_DATETIME', `Invalid local datetime ${original}`);
  }
  const fraction = match[7] ? `.${match[7]}` : '';
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${String(second).padStart(2, '0')}${fraction}`;
}

export function parseDeterministicLocalDateTime(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const original = String(value);
  const text = original.trim();
  const match = LOCAL_DATETIME.exec(text);
  if (!match) fail('INVALID_LOCAL_DATETIME', `Unsupported local datetime format: ${original}`);
  return validateLocalDateTimeMatch(match, original);
}

export function isDeterministicLocalDateTime(value) {
  try {
    return parseDeterministicLocalDateTime(value) !== null;
  } catch {
    return false;
  }
}

export function isCanonicalLocalDateTime(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  const match = CANONICAL_LOCAL_DATETIME.exec(text);
  if (!match) return false;
  try {
    return validateLocalDateTimeMatch(match, value) === text;
  } catch {
    return false;
  }
}

'''
s = replace_once(s, marker, local_helpers + marker, 'local datetime helpers')
write(p, s)

# 2. Autopilot: shared temporal predicates + truly lossless preserve-contract for CSV values.
p = 'src/core/autopilot.js'
s = read(p)
s = replace_once(
    s,
    "const ISO_DATE = /^\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?$/;\n",
    "import { isDeterministicDate, isDeterministicLocalDateTime } from './deterministic-date.js';\n",
    'autopilot temporal import'
)
s = replace_once(
    s,
    "    ['number', value => NUMBER.test(value) && Number.isFinite(Number(value))],\n    ['date', value => ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))]\n",
    "    ['number', value => NUMBER.test(value) && Number.isFinite(Number(value))],\n    ['local_datetime', value => isDeterministicLocalDateTime(value)],\n    ['date', value => isDeterministicDate(value)]\n",
    'autopilot temporal candidates'
)
s = replace_once(
    s,
    "  if (type === 'date') return { op: 'parse_date', value: field };\n  return { op: 'trim', value: field };\n",
    "  if (type === 'date') return { op: 'parse_date', value: field };\n  if (type === 'local_datetime') return { op: 'parse_local_datetime', value: field };\n  return { op: 'trim', value: field };\n",
    'autopilot expression local datetime'
)
old = """    const inferred = outcome === AUTOPILOT_OUTCOMES.DATABASE_READY
      ? inferPromotedType(field, sourceRows)
      : { type: field.type, confidence: 1, successCount: Math.min(sourceRows.length, 1000), sampleCount: Math.min(sourceRows.length, 1000), reason: 'preserve_type' };
    targetSchema.push({ name: targetName, type: inferred.type, nullable: Boolean(field.nullable) });
    mapping.push({ target: targetName, expr: expressionFor(field.name, inferred.type) });
"""
new = """    const preserveCsv = outcome === AUTOPILOT_OUTCOMES.PRESERVE_CONTRACT;
    const inferred = preserveCsv
      ? { type: 'string', confidence: 1, successCount: Math.min(sourceRows.length, 1000), sampleCount: Math.min(sourceRows.length, 1000), reason: 'preserve_csv_contract' }
      : outcome === AUTOPILOT_OUTCOMES.DATABASE_READY
        ? inferPromotedType(field, sourceRows)
        : { type: field.type, confidence: 1, successCount: Math.min(sourceRows.length, 1000), sampleCount: Math.min(sourceRows.length, 1000), reason: 'preserve_type' };
    targetSchema.push({ name: targetName, type: inferred.type, nullable: preserveCsv ? true : Boolean(field.nullable) });
    mapping.push({ target: targetName, expr: preserveCsv ? { op: 'copy', name: field.name } : expressionFor(field.name, inferred.type) });
"""
s = replace_once(s, old, new, 'preserve contract semantics')
write(p, s)

# 3. Transform IR supports local datetime without inventing a timezone.
p = 'src/core/transforms.js'
s = read(p)
s = replace_once(s, "import { parseDeterministicDate } from './deterministic-date.js';", "import { parseDeterministicDate, parseDeterministicLocalDateTime } from './deterministic-date.js';", 'transform temporal import')
s = replace_once(s, "  'cast_string', 'cast_number', 'cast_boolean', 'parse_date', 'format_date', 'regex_replace',", "  'cast_string', 'cast_number', 'cast_boolean', 'parse_date', 'parse_local_datetime', 'format_date', 'regex_replace',", 'transform op allowlist')
s = replace_once(s, "case 'cast_boolean': case 'parse_date': case 'round':", "case 'cast_boolean': case 'parse_date': case 'parse_local_datetime': case 'round':", 'transform validation')
s = replace_once(s, "    case 'parse_date': return parseDeterministicDate(evaluateExpr(expr.value, row));\n", "    case 'parse_date': return parseDeterministicDate(evaluateExpr(expr.value, row));\n    case 'parse_local_datetime': return parseDeterministicLocalDateTime(evaluateExpr(expr.value, row));\n", 'transform evaluation')
write(p, s)

# 4. Schema layer understands local_datetime as a first-class non-timezone type.
p = 'src/core/schema.js'
s = read(p)
s = replace_once(s, "import { isCanonicalDate, isDeterministicDate } from './deterministic-date.js';", "import { isCanonicalDate, isCanonicalLocalDateTime, isDeterministicDate, isDeterministicLocalDateTime } from './deterministic-date.js';", 'schema temporal import')
s = replace_once(s, "  if (/^(?:true|false)$/i.test(text)) return 'boolean';\n  if (isDeterministicDate(text)) return 'date';", "  if (/^(?:true|false)$/i.test(text)) return 'boolean';\n  if (isDeterministicLocalDateTime(text)) return 'local_datetime';\n  if (isDeterministicDate(text)) return 'date';", 'schema classify local datetime')
s = replace_once(s, "new Set(['string', 'integer', 'number', 'boolean', 'date'])", "new Set(['string', 'integer', 'number', 'boolean', 'date', 'local_datetime'])", 'schema allowed types')
s = replace_once(s, "      case 'date': valid = isCanonicalDate(value); break;", "      case 'date': valid = isCanonicalDate(value); break;\n      case 'local_datetime': valid = isCanonicalLocalDateTime(value); break;", 'schema output validation')
write(p, s)

# 5. SQLite maps local datetime to TEXT if a user explicitly targets it.
p = 'src/connectors/sqlite/preflight.js'
s = read(p)
s = replace_once(s, "  if (fieldType === 'date' || fieldType === 'string') return sqliteAffinity === 'TEXT';", "  if (fieldType === 'date' || fieldType === 'local_datetime' || fieldType === 'string') return sqliteAffinity === 'TEXT';", 'sqlite local datetime affinity')
write(p, s)

# 6. Autopilot dry-run is a real safety gate and completion truthfully distinguishes quality.
p = 'src/core/command-kernel.js'
s = read(p)
start = "    validateTargetSchema(plan.targetSchema);\n"
end = "    return this.cmd_start_migration();\n"
replacement = r'''    validateTargetSchema(plan.targetSchema);
    const compiled = compileMapping(plan.mapping);
    ensureTargetsMatch(plan.targetSchema, compiled.entries);
    const previewRevision = this.workspace.mappingRevision + 1;
    const preview = this.engine.run(
      this.workspace.source.rows.slice(0, Math.min(100, this.workspace.source.rows.length)),
      plan.mapping,
      previewRevision,
      plan.targetSchema
    );
    this.workspace.mission.dryRun = {
      processedRows: preview.processedRows,
      validRows: preview.validRows,
      invalidRows: preview.invalidRows,
      violationGroups: preview.violations.map(group => ({ code: group.code, count: group.count }))
    };
    if (preview.processedRows > 0 && preview.validRows === 0) {
      const decision = {
        code: 'DRY_RUN_ZERO_ACCEPTANCE',
        message: 'Autopilot dry run accepted zero rows. Execution was not started; revise the outcome or target interpretation.',
        sourceFields: []
      };
      this.workspace.mission.status = 'NEEDS_ATTENTION';
      this.workspace.mission.ambiguities = [...(this.workspace.mission.ambiguities ?? []), decision];
      this.workspace.mission.interventions += 1;
      this.workspace.mission.updatedAt = new Date().toISOString();
      await this.persist();
      return this.envelope({
        status: 'NEEDS_ATTENTION',
        reason: decision.code,
        ambiguityCount: this.workspace.mission.ambiguities.length,
        ambiguities: clone(this.workspace.mission.ambiguities),
        dryRun: clone(this.workspace.mission.dryRun),
        confidence: plan.confidence
      });
    }

    this.workspace.targetSchema = clone(plan.targetSchema);
    this.workspace.targetSchemaRevision += 1;
    this.workspace.job = transition(this.workspace.job, PHASES.TARGET_READY, { targetSchemaRevision: this.workspace.targetSchemaRevision });
    this.workspace.mapping = clone(plan.mapping);
    this.workspace.job = transition(this.workspace.job, PHASES.MAPPING_DRAFT);
    this.workspace.mappingRevision = previewRevision;
    this.workspace.job = transition(this.workspace.job, PHASES.MAPPING_VALID, { mappingRevision: this.workspace.mappingRevision });
    this.workspace.mission.status = 'RUNNING';
    this.workspace.mission.updatedAt = new Date().toISOString();
'''
s = replace_between(s, start, end, replacement, 'autopilot dry-run gate')
old = """    if (this.workspace.mission?.mode === 'autopilot') {
      this.workspace.mission = {
        ...this.workspace.mission,
        status: 'COMPLETE',
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        quality: {
          processedRows: this.workspace.job.processedRows,
          validRows: this.workspace.job.validRows,
          invalidRows: this.workspace.job.invalidRows
        }
      };
    }
"""
new = """    if (this.workspace.mission?.mode === 'autopilot') {
      const completionStatus = this.workspace.job.validRows === 0 && this.workspace.job.totalRows > 0
        ? 'NEEDS_ATTENTION'
        : this.workspace.job.invalidRows > 0
          ? 'COMPLETE_WITH_REJECTIONS'
          : 'COMPLETE_VERIFIED';
      this.workspace.mission = {
        ...this.workspace.mission,
        status: completionStatus,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        quality: {
          processedRows: this.workspace.job.processedRows,
          validRows: this.workspace.job.validRows,
          invalidRows: this.workspace.job.invalidRows
        }
      };
    }
"""
s = replace_once(s, old, new, 'truthful completion status')
write(p, s)

# 7. Local runner honors the configured source ceiling instead of falling back to Browser's 50 MiB parser default.
p = 'src/daemon/command-service.js'
s = read(p)
s = replace_once(s, "    const parsed = parseCsv(text);", "    const parsed = parseCsv(text, { maxInputBytes: this.maxSourceBytes });", 'local runner parser ceiling')
write(p, s)

# 8. CLI can persist raw command results, making approval -> run copy/pasteable.
p = 'src/cli/spool.js'
s = read(p)
s = replace_once(s, "import { readFile } from 'node:fs/promises';", "import { readFile, writeFile } from 'node:fs/promises';", 'cli writeFile import')
s = replace_once(s, "usage: 'spool <command> --request migration.json --source-root DIR --target-root DIR --state FILE [--approval FILE] [--expires ISO --nonce VALUE]'", "usage: 'spool <command> --request migration.json --source-root DIR --target-root DIR --state FILE [--approval FILE] [--expires ISO --nonce VALUE] [--out FILE]'", 'cli help output flag')
s = replace_once(
    s,
    "    process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\\n`);\n",
    "    if (flags.out) {\n      await writeFile(flags.out, `${JSON.stringify(result, null, 2)}\\n`, 'utf8');\n      process.stdout.write(`${JSON.stringify({ ok: true, out: flags.out })}\\n`);\n    } else {\n      process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\\n`);\n    }\n",
    'cli raw output file'
)
write(p, s)

# 9. Strict CSP: replace inline width styles with native progress elements.
p = 'src/app.js'
s = read(p)
s = replace_once(s, '<div class="progress"><i style="width:84%"></i></div>', '<progress class="progress progress-meter" max="100" value="84">84%</progress>', 'static progress CSP')
s = replace_once(s, '<div class="progress large"><i style="width:${progress}%"></i></div>', '<progress class="progress progress-meter large" max="100" value="${progress.toFixed(1)}">${progress.toFixed(1)}%</progress>', 'dynamic progress CSP')
s = replace_once(s, "    copy: 'Keep source field names and types, but run deterministic validation, checkpointing, quality grouping, and safe export.'", "    copy: 'Keep source field names and raw CSV values losslessly as nullable strings, then checkpoint, validate structure, and export safely.'", 'preserve UI semantics')
s = replace_once(s, "    COMPLETE: 'Migration complete',", "    COMPLETE: 'Migration complete',\n    COMPLETE_VERIFIED: 'Migration complete and verified',\n    COMPLETE_WITH_REJECTIONS: 'Migration complete with rejected rows',", 'mission headline statuses')
s = replace_once(
    s,
    "status === 'COMPLETE' ? 'The final output is tied to one mapping revision and the quality report is ready.' : 'Mission state is stored locally in this browser.'",
    "status === 'COMPLETE_VERIFIED' ? 'Every processed row satisfied the target contract and the final revision is ready.' : status === 'COMPLETE_WITH_REJECTIONS' ? 'Valid output is ready, and rejected rows remain explicit in the quality report.' : 'Mission state is stored locally in this browser.'",
    'mission completion copy'
)
write(p, s)

# 10. Hosted Hobby surface becomes non-commercial and Local Runner gets executable instructions.
p = 'src/product-surface.js'
s = read(p)
s = s.replace("const ASSESSMENT = `${REPO}/issues/new?template=migration-assessment.yml`;\n", "")
old_section_start = '    <section class="section"><div class="code-workflow"><div><span class="kicker">RUN IT LOCALLY</span>'
old_section_end = '    </section>\n  `);\n}\n\nfunction examplesPage() {'
i = s.find(old_section_start)
j = s.find(old_section_end, i)
if i < 0 or j < 0:
    raise RuntimeError('local runner instruction section markers not found')
local_section = r'''    <section class="section"><div class="code-workflow"><div><span class="kicker">RUN IT ON YOUR DEVICE</span><h2>Clone, verify, configure, inspect, approve, run.</h2><p>Node.js 22+ is required. Browser Studio stays capped at 50 MiB; for production SQLite mutation or larger CSV files use this customer-local runner. The current local-runner source ceiling is 256 MiB and the source/target/state paths stay on your machine.</p></div><pre>git clone https://github.com/dharan1007/spool.git
cd spool
npm ci
npm run check

# Generate a local approval-signing key for this machine/session.
export SPOOL_APPROVAL_KEY="$(openssl rand -hex 32)"
export SPOOL_COMMIT_SHA="$(git rev-parse HEAD)"

# Create migration.json from docs/LOCAL_RUNNER.md, then run the same paths for every command:
node src/cli/spool.js inspect --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db
node src/cli/spool.js plan --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db
node src/cli/spool.js dry-run --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db
node src/cli/spool.js approve --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db --expires 2026-12-31T23:59:59Z --nonce first-run --out approval.json
node src/cli/spool.js run --request migration.json --approval approval.json --source-root ./data --target-root ./data --state ./data/spool-state.db --out run-result.json
node src/cli/spool.js status --migration-id mig_customers_001 --source-root ./data --target-root ./data --state ./data/spool-state.db
node src/cli/spool.js verify --migration-id mig_customers_001 --source-root ./data --target-root ./data --state ./data/spool-state.db
node src/cli/spool.js receipt --migration-id mig_customers_001 --source-root ./data --target-root ./data --state ./data/spool-state.db --out receipt.json</pre><div class="hero-actions"><a class="button primary" href="${REPO}/blob/main/docs/LOCAL_RUNNER.md">Open full migration.json guide →</a><a class="button secondary" href="${REPO}/tree/main/examples/crm-export">Use the verified example</a></div></div></section>
'''
s = s[:i] + local_section + s[j + len('    </section>\n'):]
start = 'function servicesPage() {'
end = 'function productPage(path) {'
new_services = r'''function servicesPage() {
  return productShell('/services', `
    <section class="product-hero compact-product-hero"><div><span class="eyebrow-chip">DEPLOYMENT + SUPPORT</span><h1>This hosted site is the documentation and Browser Studio surface. <em>Production target writes stay local.</em></h1><p class="lede">The public deployment does not receive SQLite credentials or customer database rows. Clone SPOOL and run Gate B on the device that owns the source and target. This hosted surface is intentionally non-commercial while it is deployed on a personal Hobby workspace.</p><div class="hero-actions"><a class="button primary" href="/local-runner">Run SPOOL locally →</a><a class="button secondary" href="${REPO}">Open source repository</a></div></div></section>

    <section class="section"><div class="service-grid">
      <article><span>01</span><h2>Browser Studio</h2><p>Use the hosted UI for browser-local CSV inspection, deterministic transformation, quality review and safe export up to the documented Browser limit.</p></article>
      <article><span>02</span><h2>Local Runner</h2><p>Use the CLI for real CSV → SQLite mutation with source snapshot binding, target preflight, bound approval, fencing, reconciliation, verification and receipt.</p></article>
      <article><span>03</span><h2>Local Bridge</h2><p>Use <code>spoold</code> when a local developer tool or agent needs authenticated loopback access to the same command service.</p></article>
      <article class="accent"><span>04</span><h2>Self-host the public surface</h2><p>Organizations that need their own hosted documentation/UI can build the static <code>dist/</code> output and deploy it under infrastructure and terms appropriate to their use.</p></article>
    </div></section>

    <section class="section split-section"><div><span class="kicker">SUPPORT</span><h2>Public issues are metadata-only.</h2><p>Report reproducible bugs and non-sensitive feature requests in GitHub. Do not attach production datasets, credentials, private URLs, database dumps, or personal/customer records to a public issue.</p><a class="text-link" href="${REPO}/issues">Open GitHub issues →</a></div><div><span class="kicker">SELF-HOSTING</span><h2>Keep production control with the operator.</h2><p>The repository documents the release build, exact-SHA provenance, static hosting model, and local mutation boundary. The hosted UI is not a remote database execution service.</p><a class="text-link" href="${REPO}/blob/main/docs/SELF_HOSTING.md">Read self-hosting guide →</a></div></section>
  `);
}

'''
s = replace_between(s, start, end, new_services, 'noncommercial hosted services page')
write(p, s)

# 11. Make inline-style prohibition part of the release contract.
p = 'scripts/static-check.js'
s = read(p)
needle = "  if (/\\beval\\s*\\(/.test(text) || /new\\s+Function\\s*\\(/.test(text)) failures.push(`${file}: arbitrary code execution primitive detected`);\n"
s = replace_once(s, needle, needle + "  if (/\\sstyle\\s*=\\s*['\"]/i.test(text)) failures.push(`${file}: inline style attribute violates strict production CSP`);\n", 'static inline style gate')
write(p, s)

print('Production hardening patch applied successfully.')
