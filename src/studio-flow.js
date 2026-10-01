
import { planAutopilot, AUTOPILOT_OUTCOMES } from './core/autopilot.js';
import { PHASES } from './core/state-machine.js';

const FLOW = Object.freeze([
  ['/studio/original', '01', 'Original file', 'Source'],
  ['/studio/inspect', '02', 'Inspect the data', 'Inspect'],
  ['/studio/understand', '03', 'Understand columns', 'Understand'],
  ['/studio/transform', '04', 'Prepare transformation', 'Transform'],
  ['/studio/test', '05', 'Test without changes', 'Test'],
  ['/studio/process', '06', 'Process the data', 'Process'],
  ['/studio/validate', '07', 'Validate results', 'Validate']
]);
const PATHS = new Set(FLOW.map(item => item[0]));
const ALIASES = Object.freeze({
  '/studio': '/studio/original',
  '/studio/new': '/studio/original',
  '/studio/mission': '/studio/process',
  '/studio/results': '/studio/validate'
});
const READY_OR_LATER = new Set([
  PHASES.MAPPING_VALID, PHASES.RUNNING, PHASES.REPLAYING,
  PHASES.PAUSED, PHASES.PAUSED_RECOVERED, PHASES.COMPLETE
]);
const MAX_BROWSER_BYTES = 50 * 1024 * 1024;
const ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
let queued = false;
let rendering = false;
let poll = null;
let notice = null;
let busyAction = false;

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}
function num(value) { return new Intl.NumberFormat('en-US').format(Number(value || 0)); }
function pct(value, total) { return Number(total) ? ((Number(value) / Number(total)) * 100).toFixed(1) + '%' : '0.0%'; }
function size(value) {
  let n = Number(value || 0);
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return (n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
}
function rawPath() { return window.location.pathname.replace(/\/+$/, '') || '/'; }
function flowPath() { return ALIASES[rawPath()] || rawPath(); }
function isFlowPath() { return PATHS.has(flowPath()) || Object.prototype.hasOwnProperty.call(ALIASES, rawPath()); }
function api() { return window.__spoolTest || null; }
function stateFor(path) {
  const app = api();
  if (!app) return null;
  if ((path === '/studio/process' || path === '/studio/validate') && app.viewState) return app.viewState();
  return app.state();
}
function jsonRead(storage, key, fallback) {
  try { const value = storage.getItem(key); return value ? JSON.parse(value) : fallback; }
  catch { return fallback; }
}
function jsonWrite(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch {}
}
function metaKey(fp) { return 'spool:source-meta:' + (fp || 'none'); }
function planKey(fp) { return 'spool:plan:' + (fp || 'none'); }
function previewKey(state) { return 'spool:preview:' + (state && state.source ? state.source.fingerprint : 'none') + ':' + Number(state && state.mappingRevision || 0); }
function progressKey(state) { return 'spool:flow-progress:' + (state && state.source ? state.source.fingerprint : 'none'); }
function flowProgress(state) {
  if (!state || !state.source) return 0;
  let derived = 1;
  const phase = state.job && state.job.phase;
  if (READY_OR_LATER.has(phase)) derived = 4;
  if ([PHASES.RUNNING, PHASES.REPLAYING, PHASES.PAUSED, PHASES.PAUSED_RECOVERED, PHASES.COMPLETE].includes(phase)) derived = 5;
  if (phase === PHASES.COMPLETE) derived = 6;
  const saved = Number(jsonRead(sessionStorage, progressKey(state), derived));
  return Math.max(derived, Number.isFinite(saved) ? saved : derived);
}
function markProgress(state, index) {
  if (!state || !state.source) return;
  jsonWrite(sessionStorage, progressKey(state), Math.max(flowProgress(state), index));
}
function sourceMeta(state) {
  const source = state && state.source;
  const saved = source ? jsonRead(localStorage, metaKey(source.fingerprint), null) : null;
  const name = source ? source.fileName : '';
  return {
    format: saved && saved.format ? saved.format : String(name).toLowerCase().endsWith('.xlsx') ? 'XLSX' : 'CSV',
    originalName: saved && saved.originalName ? saved.originalName : name || '—',
    originalBytes: Number(saved && saved.originalBytes != null ? saved.originalBytes : source && source.bytes || 0),
    worksheet: saved && saved.worksheet || null,
    worksheetCount: saved && saved.worksheetCount || null,
    warnings: saved && Array.isArray(saved.warnings) ? saved.warnings : []
  };
}
function outcome() {
  const value = localStorage.getItem('spool:studio-outcome');
  return value === AUTOPILOT_OUTCOMES.CLEAN_STANDARDIZE ? value : AUTOPILOT_OUTCOMES.DATABASE_READY;
}
function setOutcome(value) {
  if (value === AUTOPILOT_OUTCOMES.DATABASE_READY || value === AUTOPILOT_OUTCOMES.CLEAN_STANDARDIZE) {
    localStorage.setItem('spool:studio-outcome', value);
  }
}
function savePlan(state, plan, selected) {
  if (!state || !state.source) return;
  jsonWrite(sessionStorage, planKey(state.source.fingerprint), {
    fingerprint: state.source.fingerprint,
    outcome: selected,
    evidence: plan.evidence,
    ambiguities: plan.ambiguities,
    confidence: plan.confidence
  });
}
function savedPlan(state) {
  if (!state || !state.source) return null;
  const saved = jsonRead(sessionStorage, planKey(state.source.fingerprint), null);
  return saved && saved.fingerprint === state.source.fingerprint ? saved : null;
}
function planFor(state, selected) {
  if (!state || !state.source || !Array.isArray(state.source.schema) || !Array.isArray(state.source.rows)) return null;
  return planAutopilot({ sourceSchema: state.source.schema, rows: state.source.rows, outcome: selected || outcome() });
}
function cell(value) {
  const text = String(value == null || value === '' ? '∅' : value);
  return '<span title="' + esc(text) + '">' + esc(text.length > 90 ? text.slice(0, 87) + '…' : text) + '</span>';
}
function dataTable(headers, rows, empty) {
  if (!rows || !rows.length) return '<div class="flow-empty">' + esc(empty || 'No rows to show.') + '</div>';
  return '<div class="flow-table-wrap"><table class="flow-table"><thead><tr>' +
    headers.map(h => '<th>' + esc(h) + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(value => '<td>' + value + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}
function indexFor(path) { return Math.max(0, FLOW.findIndex(item => item[0] === path)); }
function intro(index, kicker, title, copy) {
  return '<section class="flow-page-head"><div><span class="flow-kicker">' + esc(kicker) + ' · STEP ' + FLOW[index][1] +
    '</span><h1>' + title + '</h1><p>' + copy + '</p></div><div class="flow-step-count"><strong>' + FLOW[index][1] +
    '</strong><span>of 07</span></div></section>';
}
function stepStatus(state, index, current) {
  if (!state || !state.source) return index === 0 ? 'current' : 'locked';
  const progress = flowProgress(state);
  const phase = state.job.phase;
  if (index === current && index > progress) return 'locked';
  if (index === current) return 'current';
  if (index < current && index <= progress) return 'done';
  if (index === 0) return 'done';
  if (index <= progress) return 'available';
  if (index === 4 && READY_OR_LATER.has(phase)) return jsonRead(sessionStorage, previewKey(state), null) ? 'done' : 'available';
  if (index === 5 && [PHASES.RUNNING, PHASES.REPLAYING, PHASES.PAUSED, PHASES.PAUSED_RECOVERED, PHASES.COMPLETE].includes(phase)) return phase === PHASES.COMPLETE ? 'done' : 'available';
  if (index === 6 && phase === PHASES.COMPLETE) return 'available';
  return 'locked';
}
function navigate(path, replace) {
  if (!PATHS.has(path)) return;
  const state = api() && api().state ? api().state() : null;
  const targetIndex = indexFor(path);
  if (state && state.source) markProgress(state, targetIndex);
  if (replace) window.history.replaceState({}, '', path);
  else if (window.location.pathname !== path) window.history.pushState({}, '', path);
  window.scrollTo({ top: 0, behavior: 'instant' });
  schedule();
}
function shell(path, state, body) {
  const current = indexFor(path);
  const meta = sourceMeta(state);
  const nav = FLOW.map((step, index) => {
    const status = stepStatus(state, index, current);
    const locked = status === 'locked';
    const open = locked ? '<span' : '<a href="' + step[0] + '" data-flow-route="' + step[0] + '"';
    const close = locked ? '</span>' : '</a>';
    return open + ' class="flow-step ' + status + '"><i>' + step[1] + '</i><span><strong>' + esc(step[2]) +
      '</strong><small>' + (status === 'done' ? 'Completed / ready' : status === 'locked' ? 'Complete earlier stages' : status === 'current' ? 'Current stage' : 'Available') +
      '</small></span>' + close;
  }).join('');
  const mobile = FLOW.map((step, index) => {
    const status = stepStatus(state, index, current);
    if (status === 'locked') return '<span class="locked"><b>' + step[1] + '</b>' + esc(step[3]) + '</span>';
    return '<a href="' + step[0] + '" data-flow-route="' + step[0] + '" class="' + (index === current ? 'active' : '') + '"><span>' + step[1] + '</span>' + esc(step[3]) + '</a>';
  }).join('');
  const sourcePill = state && state.source
    ? '<span class="flow-file-pill"><b>' + esc(meta.format) + '</b>' + esc(meta.originalName) + '</span>'
    : '<span class="flow-file-pill muted">No source loaded</span>';
  const noticeHtml = notice
    ? '<div class="flow-notice ' + esc(notice.tone) + '"><strong>' + esc(notice.title) + '</strong><span>' + esc(notice.message) + '</span></div>'
    : '';
  return '<div class="spool-flow" data-spool-flow-root><header class="flow-topbar"><a class="flow-brand" href="/"><span>S</span><div><strong>SPOOL</strong><small>Migration Studio</small></div></a>' +
    '<div class="flow-top-context">' + sourcePill + '<a href="/docs">Docs</a><a href="/">Exit Studio</a></div></header>' +
    '<div class="flow-layout"><aside class="flow-sidebar"><div class="flow-sidebar-head"><span>STUDIO WORKFLOW</span><strong>7-stage controlled migration</strong>' +
    '<p>Each stage has one job. Nothing is applied until the transformation is approved and processing starts.</p></div><nav aria-label="Studio workflow">' + nav +
    '</nav><div class="flow-local"><i></i><div><strong>Local data plane</strong><span>Rows stay in this browser. Production CSP blocks network connections.</span></div></div></aside>' +
    '<main class="flow-main"><div class="flow-mobile-steps">' + mobile + '</div>' + noticeHtml + body + '</main></div>' +
    (busyAction ? '<div class="flow-action-lock" role="status" aria-live="polite"><div>Applying this action locally…</div></div>' : '') + '</div>';
}

function originalPage(state) {
  const source = state && state.source;
  const meta = sourceMeta(state);
  const sourceLocked = Boolean(source && [PHASES.RUNNING, PHASES.REPLAYING, PHASES.PAUSED, PHASES.PAUSED_RECOVERED].includes(state.job.phase));
  let details = '<div class="flow-empty tall"><strong>Source not loaded</strong><p>The workflow starts only after a valid CSV or XLSX is parsed locally.</p></div>';
  let preview = '';
  if (source) {
    details = '<dl class="flow-facts"><div><dt>Original format</dt><dd>' + esc(meta.format) + '</dd></div>' +
      (meta.worksheet ? '<div><dt>Worksheet</dt><dd>' + esc(meta.worksheet) + (meta.worksheetCount ? ' · ' + num(meta.worksheetCount) + ' sheets' : '') + '</dd></div>' : '') +
      '<div><dt>Original size</dt><dd>' + size(meta.originalBytes) + '</dd></div><div><dt>Rows loaded</dt><dd>' + num(source.rows.length) +
      '</dd></div><div><dt>Columns</dt><dd>' + num(source.headers.length) + '</dd></div><div class="wide"><dt>Source fingerprint</dt><dd><code>' +
      esc(source.fingerprint) + '</code></dd></div></dl>' +
      (meta.warnings.length ? '<div class="flow-warning-list">' + meta.warnings.map(w => '<span>' + esc(w) + '</span>').join('') + '</div>' : '');
    const sample = source.rows.slice(0, 6);
    const rows = sample.map((row, i) => ['<strong>' + num(i + 1) + '</strong>'].concat(source.headers.slice(0, 7).map(header => cell(row[header]))));
    preview = '<section class="flow-section"><div class="flow-section-head"><div><span class="flow-kicker">UNMODIFIED PREVIEW</span><h2>Parsed source records</h2>' +
      '<p>No transformation has been prepared or applied.</p></div><span>' + num(source.rows.length) + ' total rows</span></div>' +
      dataTable(['Row'].concat(source.headers.slice(0, 7)), rows) + '</section>' +
      '<div class="flow-page-actions"><span>Source loaded and fingerprinted.</span><a class="flow-button primary" href="/studio/inspect" data-flow-route="/studio/inspect">Continue to Inspect the data →</a></div>';
  }
  return intro(0, 'ORIGINAL SOURCE', 'Start with the file exactly as you received it.',
    'Load the original source without transforming records. CSV and XLSX are parsed locally; XLSX uses the first visible worksheet and formulas are never executed.') +
    '<section class="flow-two-col"><article class="flow-card upload-card"><div class="flow-card-title"><div><span class="flow-kicker">SOURCE FILE</span><h2>' +
    (source ? 'Replace original file' : 'Add original file') + '</h2></div>' + (source ? '<span class="flow-badge good">Loaded</span>' : '') + '</div>' +
    '<label class="flow-dropzone' + (sourceLocked ? ' locked' : '') + '" id="flow-dropzone" tabindex="' + (sourceLocked ? '-1' : '0') + '"><input type="file" id="flow-file" accept="' + ACCEPT + '" hidden' + (sourceLocked ? ' disabled' : '') + '><span class="flow-upload-icon">＋</span>' +
    '<strong>' + (sourceLocked ? 'Source replacement is locked while processing' : 'Drop CSV or XLSX here') + '</strong><p>' + (sourceLocked ? 'Finish or abort the active processing run before replacing the source.' : 'Browser Studio supports <b>.csv</b> and <b>.xlsx</b> up to 50 MiB. XLSX is normalized locally into SPOOL’s deterministic source contract.') + '</p>' +
    (sourceLocked ? '<a class="flow-button secondary" href="/studio/process" data-flow-route="/studio/process">Open current processing →</a>' : '<span class="flow-button secondary">Choose file</span>') + '</label><div class="flow-divider"><span>or</span></div><button class="flow-demo" data-flow-action="load-demo"' + (sourceLocked ? ' disabled' : '') + '>' +
    '<span><strong>Load 25k-row dirty-data example</strong><small>Useful for testing validation and rejection behavior.</small></span><b>→</b></button></article>' +
    '<article class="flow-card"><div class="flow-card-title"><div><span class="flow-kicker">SOURCE IDENTITY</span><h2>' + (source ? esc(meta.originalName) : 'Nothing loaded yet') +
    '</h2></div>' + (source ? '<span class="format-tile">' + (meta.format === 'XLSX' ? 'X' : 'C') + '</span>' : '') + '</div>' + details + '</article></section>' + preview;
}

function inspectPage(state) {
  if (!state || !state.source) return prerequisite(1, 'Load the original CSV or XLSX first.', '/studio/original', 'Go to Original file');
  const source = state.source;
  const sampleRows = source.rows.slice(0, 20).map((row, i) => ['<strong>' + num(i + 1) + '</strong>'].concat(source.headers.map(header => cell(row[header]))));
  const schemaRows = source.schema.map(field => ['<code>' + esc(field.name) + '</code>', '<span class="flow-type">' + esc(field.type) + '</span>',
    field.nullable ? '<span class="flow-badge warn">Nullable</span>' : '<span class="flow-badge good">Observed non-null</span>']);
  return intro(1, 'RAW INSPECTION', 'Inspect what is actually inside the dataset.',
    'This page is observational. It shows source shape, raw inferred types and real sample records before an output contract is proposed.') +
    metrics([
      ['Rows', num(source.rows.length), 'Parsed source records'],
      ['Columns', num(source.headers.length), 'Unique source fields'],
      ['Source size', size(source.bytes), 'Normalized local representation'],
      ['Phase', esc(state.job.phase), 'No output processing yet']
    ]) +
    '<section class="flow-section"><div class="flow-section-head"><div><span class="flow-kicker">RAW RECORDS</span><h2>Source sample</h2><p>Up to the first 20 parsed records.</p></div><span>' +
    num(Math.min(20, source.rows.length)) + ' shown</span></div>' + dataTable(['Row'].concat(source.headers), sampleRows) + '</section>' +
    '<section class="flow-section"><div class="flow-section-head"><div><span class="flow-kicker">INITIAL SCHEMA</span><h2>What the source parser sees</h2><p>These are observations, not final output types.</p></div></div>' +
    dataTable(['Column', 'Observed type', 'Nullability'], schemaRows) + '</section>' +
    actions('<a class="flow-button ghost" href="/studio/original" data-flow-route="/studio/original">← Original file</a>',
      '<a class="flow-button primary" href="/studio/understand" data-flow-route="/studio/understand">Continue to Column understanding →</a>');
}

function probableFailure(type, raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return false;
  if (type === 'boolean') return !/^(?:true|false|yes|no|y|n|0|1)$/i.test(value);
  if (type === 'integer') return !/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(Number(value));
  if (type === 'number') return !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value));
  if (type === 'date') return !/^\d{4}-\d{2}-\d{2}$/.test(value);
  if (type === 'local_datetime') return !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value);
  return false;
}
function analyze(state) {
  const rows = state.source.rows;
  const sample = rows.slice(0, 1000);
  const plan = planFor(state, AUTOPILOT_OUTCOMES.DATABASE_READY);
  const evidence = new Map(plan.evidence.map(item => [item.sourceField, item]));
  return state.source.headers.map(name => {
    const values = sample.map(row => String(row[name] == null ? '' : row[name]));
    const nonBlank = values.filter(value => value.trim() !== '');
    const ev = evidence.get(name);
    const type = ev ? ev.inferredType : (state.source.schema.find(field => field.name === name) || {}).type || 'string';
    return {
      name,
      type,
      empty: values.length - nonBlank.length,
      padded: nonBlank.filter(value => value !== value.trim()).length,
      unique: new Set(nonBlank).size,
      maxLength: nonBlank.reduce((max, value) => Math.max(max, value.length), 0),
      failures: ev ? Math.max(0, Number(ev.sampleCount) - Number(ev.successCount)) : 0,
      confidence: ev ? Number(ev.confidence) : 1,
      success: ev ? Number(ev.successCount) : nonBlank.length,
      sampled: ev ? Number(ev.sampleCount) : nonBlank.length,
      examples: Array.from(new Set(nonBlank)).slice(0, 3),
      bad: nonBlank.filter(value => probableFailure(type, value)).slice(0, 3)
    };
  });
}
function understandPage(state) {
  if (!state || !state.source) return prerequisite(2, 'Load and inspect a source before SPOOL can explain the columns.', '/studio/original', 'Go to Original file');
  if (flowProgress(state) < 2) return prerequisite(2, 'Inspect the raw data before moving to column understanding.', '/studio/inspect', 'Inspect the data');
  const columns = analyze(state);
  const issueColumns = columns.filter(item => item.empty || item.padded || item.failures).length;
  const signals = columns.reduce((sum, item) => sum + item.empty + item.padded + item.failures, 0);
  const rows = columns.map(item => {
    const issue = [];
    if (item.empty) issue.push(num(item.empty) + ' blank');
    if (item.padded) issue.push(num(item.padded) + ' padded');
    if (item.failures) issue.push(num(item.failures) + ' format mismatch');
    return [
      '<code>' + esc(item.name) + '</code><small class="cell-sub">Examples: ' + (item.examples.map(esc).join(' · ') || 'no non-empty samples') + '</small>',
      '<span class="flow-type">' + esc(item.type) + '</span><small class="cell-sub">' + Math.round(item.confidence * 100) + '% type evidence</small>',
      '<span>' + num(item.unique) + '</span><small class="cell-sub">unique in ≤1,000 rows</small>',
      '<span>' + num(item.maxLength) + '</span><small class="cell-sub">max sampled characters</small>',
      issue.length ? '<span class="flow-issue">' + esc(issue.join(' · ')) + '</span>' + (item.bad.length ? '<small class="cell-sub">Problem examples: ' + item.bad.map(esc).join(' · ') + '</small>' : '')
        : '<span class="flow-badge good">No sampled issue</span>'
    ];
  });
  return intro(2, 'COLUMN UNDERSTANDING', 'Understand columns, formats and problematic values.',
    'SPOOL profiles bounded evidence per field so you can see what each input represents and where the output contract may reject data.') +
    metrics([
      ['Columns understood', num(columns.length), 'Every source field accounted for'],
      ['Columns with signals', num(issueColumns), 'Blank, padded or format mismatch'],
      ['Observed issue signals', num(signals), 'Signals can overlap'],
      ['Analysis sample', num(Math.min(1000, state.source.rows.length)), 'Rows used for bounded evidence']
    ]) +
    '<section class="flow-section"><div class="flow-section-head"><div><span class="flow-kicker">FIELD-BY-FIELD PROFILE</span><h2>Meaning, format and problem evidence</h2><p>Input evidence is kept separate from the transformation contract.</p></div></div>' +
    dataTable(['Source column', 'Likely format', 'Cardinality', 'Max length', 'Problem signals'], rows) + '</section>' +
    '<section class="flow-callout"><div><span class="flow-kicker">FAIL-CLOSED RULE</span><h2>Ambiguous values are not silently repaired.</h2><p>Strongly evidenced values can be transformed; values that fail the agreed typed contract remain explicit rejected records.</p></div><span class="flow-callout-mark">≠</span></section>' +
    actions('<a class="flow-button ghost" href="/studio/inspect" data-flow-route="/studio/inspect">← Inspect data</a>',
      '<a class="flow-button primary" href="/studio/transform" data-flow-route="/studio/transform">Prepare transformation →</a>');
}

function exprLabel(expr) {
  const labels = {
    copy: 'Copy exactly', field: 'Read source field', trim: 'Trim whitespace',
    cast_number: 'Parse numeric value', cast_boolean: 'Normalize boolean',
    parse_date: 'Parse deterministic date', parse_local_datetime: 'Parse local date-time'
  };
  return expr && labels[expr.op] ? labels[expr.op] : expr && expr.op ? expr.op : '—';
}
function outcomeCards(selected, locked) {
  const items = [
    [AUTOPILOT_OUTCOMES.DATABASE_READY, 'Database-ready', 'Recommended', 'Normalize field names and promote strongly evidenced numeric, boolean and date formats.'],
    [AUTOPILOT_OUTCOMES.CLEAN_STANDARDIZE, 'Clean & standardize', 'Conservative', 'Normalize names and whitespace while preserving the source field types.']
  ];
  return '<div class="flow-outcomes">' + items.map(item =>
    '<button data-flow-outcome="' + item[0] + '" class="' + (selected === item[0] ? 'selected' : '') + '"' + (locked ? ' disabled' : '') +
    '><span>' + esc(item[2]) + '</span><strong>' + esc(item[1]) + '</strong><p>' + esc(item[3]) + '</p><i></i></button>').join('') + '</div>';
}
function transformPage(state) {
  if (!state || !state.source) return prerequisite(3, 'A source is required before a transformation can be prepared.', '/studio/original', 'Load original file');
  if (flowProgress(state) < 3) return prerequisite(3, 'Review the column understanding before preparing the output contract.', '/studio/understand', 'Understand columns');
  const locked = READY_OR_LATER.has(state.job.phase);
  const selected = locked && savedPlan(state) ? savedPlan(state).outcome : outcome();
  const plan = locked ? null : planFor(state, selected);
  const target = locked ? state.targetSchema : plan.targetSchema;
  const mapping = locked ? state.mapping : plan.mapping;
  const evidence = new Map((locked && savedPlan(state) ? savedPlan(state).evidence : plan.evidence).map(item => [item.targetField, item]));
  const rows = target.map((field, index) => {
    const map = mapping[index];
    const ev = evidence.get(field.name);
    const input = ev ? ev.sourceField : map && map.expr && map.expr.value ? map.expr.value.name : map && map.expr ? map.expr.name : '—';
    return [
      '<code>' + esc(input) + '</code>',
      '<code>' + esc(field.name) + '</code>',
      '<span class="flow-type">' + esc(field.type) + '</span>',
      '<span>' + esc(exprLabel(map && map.expr)) + '</span>',
      field.nullable ? '<span class="flow-badge warn">Nullable</span>' : '<span class="flow-badge good">Non-null</span>',
      ev ? '<strong>' + Math.round(Number(ev.confidence || 0) * 100) + '%</strong><small class="cell-sub">' + num(ev.successCount) + ' / ' + num(ev.sampleCount) + ' supporting values</small>' : '—'
    ];
  });
  const blocked = !locked && (plan.needsAttention || plan.ambiguities.length);
  const blockedHtml = blocked ? '<section class="flow-blocked"><span>BLOCKED</span><div><h2>Transformation requires a source decision.</h2>' +
    plan.ambiguities.map(item => '<p><strong>' + esc(item.code) + '</strong> — ' + esc(item.message) + '</p>').join('') +
    '<div class="flow-terminal-actions"><a class="flow-button secondary" href="/studio/original" data-flow-route="/studio/original">Replace source file</a><a class="flow-button ghost" href="/studio/understand" data-flow-route="/studio/understand">Review problem columns</a></div></div></section>' : '';
  return intro(3, 'TRANSFORMATION CONTRACT', 'Determine how every input field becomes a valid output field.',
    'This page prepares the target schema and constrained transformation IR only. It does not process the full dataset.') +
    '<section class="flow-section"><div class="flow-section-head"><div><span class="flow-kicker">OUTPUT INTENT</span><h2>Choose the transformation policy</h2><p>' +
    (locked ? 'The current mapping revision is already approved.' : 'Changing the policy recalculates the proposal without mutating the source.') +
    '</p></div>' + (locked ? '<span class="flow-badge good">Revision ' + num(state.mappingRevision) + ' approved</span>' : '') + '</div>' +
    outcomeCards(selected, locked) + '</section>' + blockedHtml +
    '<section class="flow-section"><div class="flow-section-head"><div><span class="flow-kicker">FIELD MAP</span><h2>' + num(rows.length) +
    ' input → output rules</h2><p>Every target field has one deterministic expression and one typed contract.</p></div></div>' +
    dataTable(['Input field', 'Output field', 'Output type', 'Transformation', 'Null policy', 'Evidence'], rows) + '</section>' +
    '<section class="flow-code-summary"><div><span class="flow-kicker">SAFETY BOUNDARY</span><h3>No generated JavaScript. No arbitrary code.</h3><p>The plan is constrained transformation data compiled by SPOOL’s allowlisted transform engine.</p></div><code>' +
    esc(mapping.map(item => item.target + ':' + (item.expr && item.expr.op || 'unknown')).join(' · ')) + '</code></section>' +
    actions('<a class="flow-button ghost" href="/studio/understand" data-flow-route="/studio/understand">← Column understanding</a>',
      locked ? '<a class="flow-button primary" href="/studio/test" data-flow-route="/studio/test">Continue to dry test →</a>'
        : '<button class="flow-button primary" data-flow-action="approve-plan"' + (blocked ? ' disabled' : '') + '>Approve transformation →</button>');
}

function previewState(state) {
  const saved = jsonRead(sessionStorage, previewKey(state), null);
  return saved && state && state.source && saved.fingerprint === state.source.fingerprint && saved.mappingRevision === state.mappingRevision ? saved : null;
}
function violationCards(groups) {
  if (!groups || !groups.length) return '<div class="flow-clean"><span>✓</span><div><strong>No violations in this result</strong><p>The evaluated rows satisfied the target contract.</p></div></div>';
  return '<div class="flow-violation-grid">' + groups.map(group => '<article><span>' + esc(group.code) + '</span><strong>' +
    num(group.count) + '</strong><p>' + esc(group.message || 'Transformation or validation violation') + '</p></article>').join('') + '</div>';
}
function testPage(state) {
  if (!state || !state.source) return prerequisite(4, 'A source and approved transformation are required.', '/studio/original', 'Load original file');
  if (!READY_OR_LATER.has(state.job.phase)) return prerequisite(4, 'Approve the field-by-field transformation before running a dry test.', '/studio/transform', 'Prepare transformation');
  const saved = previewState(state);
  const result = saved && saved.result;
  let resultHtml = '<section class="flow-test-empty"><span class="test-ring">05</span><h2>No dry test exists for revision ' + num(state.mappingRevision) +
    '.</h2><p>Run up to 100 records through the exact transformation and typed validation engine without starting the Worker.</p><button class="flow-button primary large" data-flow-action="run-preview">Run dry test now</button></section>';
  if (result) {
    const output = (result.output || []).slice(0, 12);
    const headers = output.length ? Object.keys(output[0]) : state.targetSchema.map(field => field.name);
    const rows = output.map((row, i) => ['<strong>' + num(i + 1) + '</strong>'].concat(headers.map(header => cell(row[header]))));
    resultHtml = metrics([
      ['Rows tested', num(result.processedRows), 'Real engine, bounded sample'],
      ['Passed', num(result.validRows), 'Typed output accepted'],
      ['Rejected', num(result.invalidRows), 'Kept explicit'],
      ['Acceptance', pct(result.validRows, result.processedRows), 'Dry-run result only']
    ]) +
    '<section class="flow-section"><div class="flow-section-head"><div><span class="flow-kicker">TEST OUTPUT</span><h2>Transformed sample</h2><p>Preview output only; no durable output has been committed.</p></div><span>' +
    num(output.length) + ' shown</span></div>' + dataTable(['Row'].concat(headers), rows) + '</section>' +
    '<section class="flow-section"><div class="flow-section-head"><div><span class="flow-kicker">TEST VIOLATIONS</span><h2>What would fail</h2></div></div>' +
    violationCards(result.violations) + '</section>';
  }
  return intro(4, 'DRY RUN', 'Test the transformation without committing changes.',
    'The dry test uses SPOOL’s real migration engine on a bounded sample. It does not start the Worker, advance a checkpoint, or create durable output rows.') +
    '<section class="flow-safety-banner"><div><span>READ-ONLY TEST</span><strong>Current durable output remains untouched.</strong><p>Mapping revision ' + num(state.mappingRevision) +
    ' · source fingerprint ' + esc(String(state.source.fingerprint).slice(0, 18)) + '…</p></div><i>TEST</i></section>' + resultHtml +
    actions('<a class="flow-button ghost" href="/studio/transform" data-flow-route="/studio/transform">← Transformation</a>',
      result ? '<button class="flow-button secondary" data-flow-action="run-preview">Re-run test</button><a class="flow-button primary" href="/studio/process" data-flow-route="/studio/process">Approve test & continue →</a>' : '');
}
function processPage(state) {
  if (!state || !state.source) return prerequisite(5, 'A source is required.', '/studio/original', 'Load original file');
  const phase = state.job.phase;
  if (phase === PHASES.FAILED || phase === PHASES.ABORTED) {
    const reason = state.lastError && state.lastError.message ? state.lastError.message : (phase === PHASES.ABORTED ? 'The processing run was aborted.' : 'The processing run stopped safely.');
    return intro(5, 'EXECUTION STOPPED', phase === PHASES.ABORTED ? 'Processing was aborted.' : 'Processing failed safely.',
      'SPOOL did not leave this run in a fake running state. Review the reason below, then start a clean migration when ready.') +
      '<section class="flow-blocked"><span>' + esc(phase) + '</span><div><h2>No processing action is running.</h2><p>' + esc(reason) + '</p>' +
      '<div class="flow-terminal-actions"><button class="flow-button primary" data-flow-action="reset-terminal">Start a new migration</button>' +
      '<a class="flow-button secondary" href="/studio/understand" data-flow-route="/studio/understand">Review source problems</a></div></div></section>' +
      actions('<a class="flow-button ghost" href="/studio/original" data-flow-route="/studio/original">← Original file</a>', '<span>Resolve the failure before starting another run.</span>');
  }
  if (!READY_OR_LATER.has(phase)) return prerequisite(5, 'Approve and validate the transformation first.', '/studio/transform', 'Prepare transformation');
  const running = phase === PHASES.RUNNING || phase === PHASES.REPLAYING;
  const paused = phase === PHASES.PAUSED || phase === PHASES.PAUSED_RECOVERED;
  const complete = phase === PHASES.COMPLETE;
  const preview = previewState(state);
  const progress = Number(state.job.totalRows) ? Math.min(100, Number(state.job.processedRows) / Number(state.job.totalRows) * 100) : 0;
  const blocked = !preview && phase === PHASES.MAPPING_VALID
    ? '<section class="flow-blocked"><span>TEST REQUIRED</span><div><h2>Run the dry test before processing.</h2><p>The current mapping revision has not completed the explicit non-committing test stage.</p><a class="flow-button secondary" href="/studio/test" data-flow-route="/studio/test">Go to Test without changes</a></div></section>' : '';
  let buttons = '';
  if (phase === PHASES.MAPPING_VALID && preview) buttons = '<button class="flow-button primary large" data-flow-action="start-process">Process the full dataset</button>';
  if (running) buttons = '<button class="flow-button secondary" data-flow-action="pause-process">Pause safely</button>';
  if (paused) buttons = '<button class="flow-button primary" data-flow-action="resume-process">Resume from checkpoint</button>';
  if (complete) buttons = '<a class="flow-button primary large" href="/studio/validate" data-flow-route="/studio/validate">Validate final results →</a>';
  const title = complete ? 'Processing complete' : running ? 'Processing records' : paused ? 'Processing paused at a durable checkpoint' : 'Ready to process';
  const copy = complete ? 'Every source record reached a terminal accepted or rejected result for this revision.'
    : running ? 'Worker batches are applying the approved transformation and persisting local checkpoints.'
      : paused ? 'No new batches are being applied until you resume.' : 'Starting will execute the approved mapping from row zero.';
  return intro(5, 'EXECUTION', 'Process the data with the agreed transformation.',
    'This is the first stage that commits transformed records into SPOOL’s durable browser result state. A mapping revision is fixed for the run.') +
    blocked + '<section class="flow-process-panel"><div class="flow-process-status"><span class="flow-kicker">RUN STATUS</span><h2>' + title +
    '</h2><p>' + copy + '</p></div><div class="flow-progress-number"><strong>' + progress.toFixed(1) + '%</strong><span>' + num(state.job.processedRows) +
    ' / ' + num(state.job.totalRows) + ' rows</span></div><div class="flow-progress-track"><i style="width:' + progress.toFixed(2) +
    '%"></i></div><div class="flow-process-stats"><div><span>Valid</span><strong>' + num(state.job.validRows) + '</strong></div><div><span>Rejected</span><strong>' +
    num(state.job.invalidRows) + '</strong></div><div><span>Checkpoint</span><strong>' + num(state.job.checkpoint) + '</strong></div><div><span>Mapping revision</span><strong>' +
    num(state.mappingRevision) + '</strong></div></div><div class="flow-process-actions">' + buttons + '</div></section>' +
    '<section class="flow-section"><div class="flow-section-head"><div><span class="flow-kicker">EXECUTION GUARANTEES</span><h2>What SPOOL enforces while records move</h2></div></div>' +
    '<div class="flow-guarantee-grid"><article><strong>Typed validation</strong><p>Every accepted row satisfies the target schema.</p></article><article><strong>Revision identity</strong><p>No mixed mapping revisions in one output.</p></article>' +
    '<article><strong>Durable checkpoint</strong><p>Progress persists locally for recovery.</p></article><article><strong>Explicit rejection</strong><p>Invalid rows are grouped instead of silently coerced.</p></article></div></section>' +
    actions('<a class="flow-button ghost" href="/studio/test" data-flow-route="/studio/test">← Dry test</a>',
      complete ? '<a class="flow-button primary" href="/studio/validate" data-flow-route="/studio/validate">Validate results →</a>' : '<span>Final validation unlocks after processing completes.</span>');
}
function validatePage(state) {
  if (!state || !state.source) return prerequisite(6, 'A completed migration is required for final validation.', '/studio/original', 'Load original file');
  if (state.job.phase !== PHASES.COMPLETE) return prerequisite(6, 'Finish processing the full dataset before final validation.', '/studio/process', 'Open Process data');
  const rows = (state.output || []).slice(0, 12);
  const headers = rows.length ? Object.keys(rows[0]) : state.targetSchema.map(field => field.name);
  const outputRows = rows.map((row, i) => ['<strong>' + num(i + 1) + '</strong>'].concat(headers.map(header => cell(row[header]))));
  const schemaRows = state.targetSchema.map(field => ['<code>' + esc(field.name) + '</code>', '<span class="flow-type">' + esc(field.type) + '</span>',
    field.nullable ? '<span class="flow-badge warn">Nullable</span>' : '<span class="flow-badge good">Non-null</span>']);
  const processed = Number(state.job.processedRows || 0);
  const valid = Number(state.job.validRows || 0);
  return intro(6, 'FINAL VALIDATION', 'Validate the processed result before export.',
    'Close the loop with final counts, target-contract evidence, violation classes and actual revision-consistent output rows.') +
    '<section class="flow-validation-hero"><div class="flow-check">✓</div><div><span class="flow-kicker">REVISION ' + num(state.outputRevision) + ' COMPLETE</span><h2>' +
    (valid === processed ? 'All processed rows satisfy the target contract.' : num(valid) + ' valid rows are ready; ' + num(state.job.invalidRows) + ' rows remain explicitly rejected.') +
    '</h2><p>Processed rows equal valid plus rejected rows for the completed job.</p></div><div class="flow-export-actions"><button class="flow-button secondary" data-flow-action="export-json">Export JSON</button><button class="flow-button primary" data-flow-action="export-csv">Export CSV</button></div></section>' +
    metrics([
      ['Processed', num(processed), 'Full source run'],
      ['Valid output', num(valid), 'Passed target validation'],
      ['Rejected', num(state.job.invalidRows), 'Not silently exported'],
      ['Acceptance', pct(valid, processed), 'Final, not sampled']
    ]) +
    '<section class="flow-section"><div class="flow-section-head"><div><span class="flow-kicker">QUALITY VALIDATION</span><h2>Violation classes</h2><p>Rejected records remain grouped and auditable.</p></div></div>' +
    violationCards(state.violations) + '</section><section class="flow-section"><div class="flow-section-head"><div><span class="flow-kicker">OUTPUT CONTRACT</span><h2>Validated target fields</h2></div><span>Mapping revision ' +
    num(state.mappingRevision) + '</span></div>' + dataTable(['Output field', 'Type', 'Null policy'], schemaRows) + '</section>' +
    '<section class="flow-section"><div class="flow-section-head"><div><span class="flow-kicker">VALID OUTPUT SAMPLE</span><h2>Actual processed rows</h2><p>Only rows that passed the typed contract appear in exports.</p></div><span>' +
    num(rows.length) + ' shown</span></div>' + dataTable(['Row'].concat(headers), outputRows, 'No valid output rows are available.') + '</section>' +
    actions('<a class="flow-button ghost" href="/studio/process" data-flow-route="/studio/process">← Processing</a><button class="flow-button secondary" data-flow-action="new-source">Start a new source</button>',
      '<button class="flow-button primary" data-flow-action="export-csv">Export validated CSV</button>');
}
function prerequisite(index, message, href, label) {
  return intro(index, 'PREREQUISITE', esc(FLOW[index][2]), esc(message)) +
    '<section class="flow-test-empty"><span class="test-ring">' + FLOW[index][1] + '</span><h2>This stage is not ready yet.</h2><p>' +
    esc(message) + '</p><a class="flow-button primary" href="' + href + '" data-flow-route="' + href + '">' + esc(label) + ' →</a></section>';
}
function metrics(items) {
  return '<section class="flow-metrics">' + items.map(item => '<article><span>' + item[0] + '</span><strong>' + item[1] + '</strong><small>' + item[2] + '</small></article>').join('') + '</section>';
}
function actions(left, right) { return '<div class="flow-page-actions"><div>' + left + '</div><div>' + right + '</div></div>'; }
function page(path, state) {
  if (path === '/studio/original') return originalPage(state);
  if (path === '/studio/inspect') return inspectPage(state);
  if (path === '/studio/understand') return understandPage(state);
  if (path === '/studio/transform') return transformPage(state);
  if (path === '/studio/test') return testPage(state);
  if (path === '/studio/process') return processPage(state);
  if (path === '/studio/validate') return validatePage(state);
  return originalPage(state);
}
function managePoll(state, path) {
  const should = path === '/studio/process' && state && (state.job.phase === PHASES.RUNNING || state.job.phase === PHASES.REPLAYING);
  if (should && !poll) poll = window.setInterval(schedule, 400);
  if (!should && poll) { window.clearInterval(poll); poll = null; }
}
function renderFlow() {
  if (rendering || !isFlowPath()) return;
  const root = document.getElementById('app-root');
  if (!root || !api()) return;
  let path = flowPath();
  if (!PATHS.has(path)) path = '/studio/original';
  if (rawPath() !== path) window.history.replaceState({}, '', path);
  const state = stateFor(path);
  if (!state) return;
  rendering = true;
  try {
    root.innerHTML = shell(path, state, page(path, state));
    document.title = FLOW[indexFor(path)][2] + ' — SPOOL Studio';
    managePoll(state, path);
  } finally { rendering = false; }
}
function schedule() {
  if (queued) return;
  queued = true;
  window.requestAnimationFrame(() => { queued = false; renderFlow(); });
}
function setNotice(tone, title, message) {
  notice = { tone, title, message };
  schedule();
  window.clearTimeout(setNotice.timer);
  setNotice.timer = window.setTimeout(() => { notice = null; schedule(); }, 5000);
}
async function upload(file) {
  if (!file || busyAction) return;
  const current = api() && api().state ? api().state() : null;
  if (current && [PHASES.RUNNING, PHASES.REPLAYING, PHASES.PAUSED, PHASES.PAUSED_RECOVERED].includes(current.job.phase)) {
    return setNotice('danger', 'Source replacement locked', 'Finish or abort the active processing run before loading a different source.');
  }
  if (Number(file.size || 0) > MAX_BROWSER_BYTES) return setNotice('danger', 'File too large', 'Browser Studio accepts CSV/XLSX files up to 50 MiB.');
  const lower = String(file.name || '').toLowerCase();
  const csv = lower.endsWith('.csv') || file.type === 'text/csv';
  const xlsx = lower.endsWith('.xlsx') || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (!csv && !xlsx) return setNotice('danger', 'Unsupported file', 'Choose a .csv or .xlsx source file.');
  try {
    let text;
    let meta;
    if (xlsx) {
      setNotice('neutral', 'Reading workbook locally', 'Opening the first visible worksheet. Formulas are not executed.');
      const module = await import('./xlsx-ingest.js');
      const converted = await module.xlsxFileToCsv(file);
      text = converted.csv;
      meta = { format: 'XLSX', originalName: file.name, originalBytes: file.size, worksheet: converted.sheetName,
        worksheetCount: converted.sheetNames.length, warnings: converted.warnings, loadedAt: new Date().toISOString() };
    } else {
      text = await file.text();
      meta = { format: 'CSV', originalName: file.name, originalBytes: file.size, worksheet: null, worksheetCount: null, warnings: [], loadedAt: new Date().toISOString() };
    }
    const loaded = await api().loadCsv(text, file.name);
    if (loaded && loaded.ok === false) throw new Error(loaded.message || 'SPOOL refused to replace the active source.');
    const state = api().state();
    if (!state || !state.source) throw new Error('SPOOL did not create a source workspace.');
    jsonWrite(localStorage, metaKey(state.source.fingerprint), meta);
    notice = null;
    navigate('/studio/inspect');
  } catch (error) {
    setNotice('danger', 'Could not load source', error && error.message ? error.message : String(error));
  }
}
async function approve() {
  const state = api().state();
  if (!state || !state.source || state.job.phase !== PHASES.SOURCE_READY) return setNotice('danger', 'Transformation unavailable', 'Return to a source-ready workspace first.');
  const selected = outcome();
  const plan = planFor(state, selected);
  if (!plan || plan.needsAttention || plan.ambiguities.length) return setNotice('danger', 'Transformation blocked', 'Resolve the source naming ambiguity before approval.');
  savePlan(state, plan, selected);
  let response = await api().invoke('define_target_schema', { fields: plan.targetSchema });
  if (!response.ok) return setNotice('danger', response.error.code, response.error.message);
  response = await api().invoke('set_mapping', { mapping: plan.mapping });
  if (!response.ok) return setNotice('danger', response.error.code, response.error.message);
  response = await api().invoke('validate_mapping', {});
  if (!response.ok) return setNotice('danger', response.error.code, response.error.message);
  setNotice('success', 'Transformation approved', 'Mapping revision ' + num(api().state().mappingRevision) + ' is ready for a non-committing test.');
  navigate('/studio/test');
}
async function preview() {
  const state = api().state();
  if (!state || state.job.phase !== PHASES.MAPPING_VALID) return setNotice('danger', 'Dry test unavailable', 'Validate the transformation first.');
  const response = await api().invoke('preview_migration', { limit: 100 });
  if (!response.ok) return setNotice('danger', response.error.code, response.error.message);
  jsonWrite(sessionStorage, previewKey(state), { fingerprint: state.source.fingerprint, mappingRevision: state.mappingRevision,
    testedAt: new Date().toISOString(), result: response.result });
  setNotice('success', 'Dry test finished', num(response.result.validRows) + ' of ' + num(response.result.processedRows) + ' tested rows passed.');
  schedule();
}
async function startProcess() {
  const state = api().state();
  if (!previewState(state)) return setNotice('danger', 'Dry test required', 'Run the non-committing test for this mapping revision first.');
  const response = await api().invoke('start_migration', {});
  if (!response.ok) return setNotice('danger', response.error.code, response.error.message);
  setNotice('success', 'Processing started', 'The full dataset is running through the approved transformation.');
  schedule();
}
function download(result) {
  const blob = new Blob([result.content], { type: result.mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = result.fileName; document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function action(name) {
  if (busyAction) return;
  busyAction = true;
  schedule();
  try {
  if (name === 'load-demo') {
    const loaded = await api().loadDemo();
    if (loaded && loaded.ok === false) return setNotice('danger', loaded.code || 'LOAD_BLOCKED', loaded.message || 'Could not load demo source.');
    const state = api().state();
    if (state && state.source) jsonWrite(localStorage, metaKey(state.source.fingerprint), {
      format: 'CSV', originalName: state.source.fileName, originalBytes: state.source.bytes, worksheet: null, worksheetCount: null, warnings: []
    });
    return navigate('/studio/inspect');
  }
  if (name === 'approve-plan') return approve();
  if (name === 'run-preview') return preview();
  if (name === 'start-process') return startProcess();
  if (name === 'pause-process') {
    const response = await api().invoke('pause_run', {});
    if (!response.ok) setNotice('danger', response.error.code, response.error.message);
    else setNotice('success', 'Processing paused', 'Durable checkpoint ' + num(response.result.checkpoint) + ' is saved.');
    return schedule();
  }
  if (name === 'resume-process') {
    const response = await api().invoke('resume_run', {});
    if (!response.ok) setNotice('danger', response.error.code, response.error.message);
    else setNotice('success', 'Processing resumed', response.result.replaying ? 'Mapping changed; replay started from row zero.' : 'Continuing from the durable checkpoint.');
    return schedule();
  }
  if (name === 'export-csv' || name === 'export-json') {
    const response = await api().invoke(name === 'export-csv' ? 'export_csv' : 'export_json', {});
    if (!response.ok) return setNotice('danger', response.error.code, response.error.message);
    return download(response.result);
  }
  if (name === 'reset-terminal') {
    const response = await api().invoke('start_new_migration', {});
    if (!response.ok) return setNotice('danger', response.error.code, response.error.message);
    setNotice('success', 'New migration ready', 'The previous terminal run was cleared. Load or review the source from step 1.');
    return navigate('/studio/original');
  }
  if (name === 'new-source') {
    const state = api().state();
    if (state && [PHASES.COMPLETE, PHASES.FAILED, PHASES.ABORTED].includes(state.job.phase)) {
      const response = await api().invoke('start_new_migration', {});
      if (!response.ok) return setNotice('danger', response.error.code, response.error.message);
    }
    return navigate('/studio/original');
  }
  } finally {
    busyAction = false;
    schedule();
  }
}

document.addEventListener('click', event => {
  if (!isFlowPath()) return;
  const route = event.target.closest('[data-flow-route]');
  if (route) { event.preventDefault(); navigate(route.dataset.flowRoute); return; }
  const choice = event.target.closest('[data-flow-outcome]');
  if (choice && !choice.disabled) { setOutcome(choice.dataset.flowOutcome); schedule(); return; }
  const button = event.target.closest('[data-flow-action]');
  if (button && !button.disabled) { event.preventDefault(); void action(button.dataset.flowAction); }
}, true);
document.addEventListener('change', event => {
  if (isFlowPath() && event.target && event.target.id === 'flow-file') void upload(event.target.files && event.target.files[0]);
}, true);
document.addEventListener('keydown', event => {
  if (isFlowPath() && event.target && event.target.id === 'flow-dropzone' && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault(); const input = document.getElementById('flow-file'); if (input) input.click();
  }
}, true);
document.addEventListener('dragover', event => {
  if (!isFlowPath()) return;
  const zone = event.target.closest && event.target.closest('#flow-dropzone');
  if (zone) { event.preventDefault(); zone.classList.add('dragover'); }
}, true);
document.addEventListener('dragleave', event => {
  const zone = event.target.closest && event.target.closest('#flow-dropzone'); if (zone) zone.classList.remove('dragover');
}, true);
document.addEventListener('drop', event => {
  if (!isFlowPath()) return;
  const zone = event.target.closest && event.target.closest('#flow-dropzone');
  if (zone) { event.preventDefault(); zone.classList.remove('dragover'); void upload(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]); }
}, true);
window.addEventListener('popstate', schedule);
window.addEventListener('spool:statechange', schedule);
window.addEventListener('spool:studio-route', schedule);

const root = document.getElementById('app-root');
if (root) {
  const observer = new MutationObserver(() => {
    if (isFlowPath() && !rendering && !root.querySelector('[data-spool-flow-root]')) schedule();
  });
  observer.observe(root, { childList: true });
}
const bootPoll = window.setInterval(() => {
  if (isFlowPath() && api()) { window.clearInterval(bootPoll); schedule(); }
}, 40);
window.setTimeout(() => window.clearInterval(bootPoll), 15000);
if (api()) schedule();
