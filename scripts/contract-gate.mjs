#!/usr/bin/env node
// Contract gate — Rules A–G machine-checkable subset.
// Usage: node scripts/contract-gate.mjs [--strict] [--root <dir>]
// Exit 0 pass, 2 fail. No dependencies.
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, extname } from 'node:path';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const rootIdx = args.indexOf('--root');
const ROOT = rootIdx >= 0 ? args[rootIdx + 1] : new URL('..', import.meta.url).pathname.replace(/\/$/, '');
import { fileURLToPath } from 'node:url';
const rootDir = rootIdx >= 0 ? args[rootIdx + 1] : fileURLToPath(new URL('..', import.meta.url));

const PROD_DIR_NAMES = new Set(['src', 'lib', 'api', 'bin', 'extension', 'models', 'schema', 'pages', 'types', 'scripts', 'integrations']);
const EXCLUDED_PARTS = new Set(['node_modules', '.git', 'dist', 'public', 'vendor', '.bootstrap', 'deploy', '.next', 'coverage', 'screenshots']);
const TEST_HINT = /(^|\/)(tests?|__tests__|__mocks__)(\/|$)/;
const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py']);

const ERROR_PATTERNS = [
  [/NotImplemented/, 'NotImplemented in production path'],
  [/dummy\s*[-_ ]?provider/i, 'dummy provider in production path'],
  [/fake\s*[-_ ]?success/i, 'fake success in production path'],
  [/mock\s*[-_ ]?result/i, 'mock result in production path'],
  [/HARDCODED_BENCHMARK/, 'hard-coded benchmark marker'],
  [/hard-?coded.*benchmark.*(output|answer)/i, 'hard-coded benchmark output'],
  [/DEMO_ONLY|demo-only|demoOnly/, 'demo-only branch in production path'],
  [/FAKE_DATA|fakeData/, 'fake data in production path'],
  [/special-?case.*benchmark.*id|benchmark.*id.*special-?case/i, 'benchmark task-ID special-casing'],
  [/hard-?coded.*answer/i, 'hard-coded answer'],
];

const WARN_PATTERNS = [
  [/\bTODO\b/, 'TODO in production path'],
  [/\bFIXME\b/, 'FIXME in production path'],
  [/\bsleep\s*\(/, 'sleep-based synchronization in production path'],
  [/Math\.random/, 'Math.random near production logic (verify not evidence)'],
  [/catch\s*\([^)]*\)\s*\{[^}]{0,200}return\s*(true|['"]?(ok|success)['"]?)/, 'catch-all returning success'],
  [/fallback/i, 'fallback keyword (verify not silent fake-data fallback)'],
];

const REQUIRED_MATRIX_STATUSES = new Set(['PRODUCTION', 'EXPERIMENTAL', 'PLANNED', 'UNSUPPORTED']);
const PROD_EVIDENCE_FIELDS = ['implementation', 'integrationTest', 'faultTest', 'securityTest', 'loadTest', 'benchmarkEvidence', 'limits'];
const FORBIDDEN_MANIFEST_KEYS = ['expectedOutputs', 'hardcodedAnswers', 'specialCaseIds', 'tunedOnEvalSplit'];
const RULE_C_FIELDS = ['benchmarkCommit', 'competitorVersion', 'sourceCommit', 'operatingSystem', 'cpu', 'ram', 'databaseVersions', 'browserVersions', 'llmModel', 'reasoningConfig', 'temperature', 'tokenBudget', 'toolCallBudget', 'wallClockTimeout', 'retryPolicy', 'networkConfig', 'seed', 'promptScaffold', 'humanInterventions', 'cost', 'finalScore'];

async function walk(dir, out = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (EXCLUDED_PARTS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (TEST_HINT.test('/' + relative(rootDir, full) + '/')) continue;
      await walk(full, out);
    } else if (e.isFile() && CODE_EXTS.has(extname(e.name))) {
      const rel = relative(rootDir, full);
      if (TEST_HINT.test('/' + rel)) continue;
      if (/\.test\.[a-z]+$/.test(e.name) || /\.spec\.[a-z]+$/.test(e.name)) continue;
      const top = rel.split(/[/\\]/)[0];
      // scripts/contract-gate itself is exempt from self-incrimination on pattern names inside strings
      if (rel.replace(/\\/g, '/') === 'scripts/contract-gate.mjs') continue;
      if (PROD_DIR_NAMES.has(top) || top === 'scripts-contract-gate.mjs' || rel.startsWith('bin/')) out.push(full);
      // Also scan root-level scripts-*.mjs (faultline convention)
      if (/^scripts-.*\.mjs$/.test(rel)) out.push(full);
    }
  }
  return out;
}

function hasSuppression(line) { return line.includes('contract-gate:allow'); }

async function scanFakeCode() {
  const files = await walk(rootDir);
  const errors = [];
  const warnings = [];
  for (const file of files) {
    let text = '';
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (hasSuppression(line)) return;
      for (const [re, msg] of ERROR_PATTERNS) {
        if (re.test(line)) errors.push(`${relative(rootDir, file)}:${i + 1}: ERROR ${msg}: ${line.trim().slice(0, 160)}`);
      }
      for (const [re, msg] of WARN_PATTERNS) {
        if (re.test(line)) warnings.push(`${relative(rootDir, file)}:${i + 1}: WARN ${msg}: ${line.trim().slice(0, 160)}`);
      }
    });
  }
  return { errors, warnings };
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { return { __readError: String(e?.message || e) }; }
}

async function checkMatrix() {
  const errors = [], warnings = [];
  const path = join(rootDir, 'capability-matrix.json');
  try { await stat(path); } catch { return { errors: [`capability-matrix.json missing at repo root`], warnings }; }
  const data = await readJson(path);
  if (data.__readError) return { errors: [`capability-matrix.json invalid JSON: ${data.__readError}`], warnings };
  const caps = Array.isArray(data) ? data : data.capabilities;
  if (!Array.isArray(caps)) return { errors: ['capability-matrix.json must be an array or {capabilities:[...]}'], warnings };
  const ids = new Set();
  for (const [idx, cap] of caps.entries()) {
    const where = `capability[${cap?.id || idx}]`;
    if (!cap?.id) { errors.push(`${where}: missing id`); continue; }
    if (ids.has(cap.id)) errors.push(`${where}: duplicate id`);
    ids.add(cap.id);
    if (!REQUIRED_MATRIX_STATUSES.has(cap.status)) { errors.push(`${where}: status must be one of PRODUCTION/EXPERIMENTAL/PLANNED/UNSUPPORTED, got ${JSON.stringify(cap.status)}`); continue; }
    if (cap.status === 'PRODUCTION') {
      for (const field of PROD_EVIDENCE_FIELDS) {
        if (!cap[field]) errors.push(`${where}: PRODUCTION requires evidence field '${field}'`);
      }
      if (cap.benchmarkEvidence && !/benchmarks\/results\//.test(String(cap.benchmarkEvidence)) && !/https?:\/\//.test(String(cap.benchmarkEvidence))) {
        warnings.push(`${where}: benchmarkEvidence should point at benchmarks/results/... or a public URL (Rule A)`);
      }
    }
  }
  return { errors, warnings };
}

async function checkBenchmarks() {
  const errors = [], warnings = [];
  const bench = join(rootDir, 'benchmarks');
  try { await stat(bench); } catch { return { errors: ['benchmarks/ directory missing (Rule G)'], warnings }; }
  for (const sub of ['manifests', 'adapters', 'runners', 'baselines', 'results', 'reports']) {
    try { await stat(join(bench, sub)); } catch { errors.push(`benchmarks/${sub}/ missing (Rule G)`); }
  }
  let manifests = [];
  try { manifests = (await readdir(join(bench, 'manifests'))).filter(f => f.endsWith('.json')); } catch { manifests = []; }
  for (const file of manifests) {
    const data = await readJson(join(bench, 'manifests', file));
    if (data.__readError) { errors.push(`benchmarks/manifests/${file}: invalid JSON`); continue; }
    for (const key of FORBIDDEN_MANIFEST_KEYS) {
      if (data[key] !== undefined) errors.push(`benchmarks/manifests/${file}: forbidden key '${key}' (Rule B)`);
    }
    if (data.excludedFailures !== undefined && !Array.isArray(data.excludedFailures)) {
      errors.push(`benchmarks/manifests/${file}: excludedFailures must be an array of {id,reason,link}`);
    }
    if (Array.isArray(data.excludedFailures)) {
      for (const ex of data.excludedFailures) {
        if (!ex?.id || !ex?.reason) errors.push(`benchmarks/manifests/${file}: every excludedFailure needs id+reason (Rule B)`);
      }
      if (data.excludedFailures.length > 0) warnings.push(`benchmarks/manifests/${file}: publishes ${data.excludedFailures.length} exclusion(s) — ensure report links them`);
    }
    if (!data.benchmarkRepo) warnings.push(`benchmarks/manifests/${file}: missing benchmarkRepo (Rule B pin required)`);
    if (data.benchmarkCommit && !/^[0-9a-f]{40}$/.test(data.benchmarkCommit)) warnings.push(`benchmarks/manifests/${file}: benchmarkCommit should be a 40-char SHA`);
    if (!data.benchmarkCommit) warnings.push(`benchmarks/manifests/${file}: missing benchmarkCommit SHA pin (Rule B)`);
    if (data.container && !data.containerDigest) warnings.push(`benchmarks/manifests/${file}: container without containerDigest pin`);
  }
  return { errors, warnings };
}

async function checkResultsStrict() {
  const errors = [], warnings = [];
  if (!strict) return { errors, warnings };
  const resultsRoot = join(rootDir, 'benchmarks', 'results');
  let suites = [];
  try { suites = await readdir(resultsRoot, { withFileTypes: true }); } catch { return { errors, warnings }; }
  for (const suite of suites) {
    if (!suite.isDirectory()) continue;
    const suiteDir = join(resultsRoot, suite.name);
    let runs = [];
    try { runs = await readdir(suiteDir, { withFileTypes: true }); } catch { continue; }
    for (const run of runs) {
      if (!run.isDirectory()) continue;
      const runDir = join(suiteDir, run.name);
      const manifest = await readJson(join(runDir, 'manifest.json'));
      if (manifest.__readError) { errors.push(`results/${suite.name}/${run.name}/manifest.json missing or invalid`); continue; }
      for (const field of RULE_C_FIELDS) {
        if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
          errors.push(`results/${suite.name}/${run.name}/manifest.json: missing Rule C field '${field}'`);
        }
      }
      // hash verification when sha256sums.txt present
      let sumsText = '';
      try { sumsText = await readFile(join(runDir, 'sha256sums.txt'), 'utf8'); } catch { continue; }
      for (const line of sumsText.split('\n').map(s => s.trim()).filter(Boolean)) {
        const [expected, ...rest] = line.split(/\s+/);
        const fname = rest.at(-1);
        if (!expected || !fname) continue;
        let buf;
        try { buf = await readFile(join(runDir, fname)); } catch { errors.push(`results/${suite.name}/${run.name}/${fname}: listed in sha256sums.txt but unreadable`); continue; }
        const actual = createHash('sha256').update(buf).digest('hex');
        if (actual !== expected.toLowerCase()) errors.push(`results/${suite.name}/${run.name}/${fname}: sha256 mismatch (evidence mutated?)`);
      }
    }
  }
  return { errors, warnings };
}

const fake = await scanFakeCode();
const matrix = await checkMatrix();
const bench = await checkBenchmarks();
const results = await checkResultsStrict();

const errors = [...fake.errors, ...matrix.errors, ...bench.errors, ...results.errors];
let warnings = [...fake.warnings, ...matrix.warnings, ...bench.warnings];
if (strict) {
  // In strict mode, TODO/FIXME/sleep warnings become errors (Rule E release bar)
  const strictFromWarn = warnings.filter(w => /TODO|FIXME|sleep-based/.test(w));
  warnings = warnings.filter(w => !/TODO|FIXME|sleep-based/.test(w));
  for (const w of strictFromWarn) errors.push(w.replace(': WARN ', ': ERROR(strict) '));
}

for (const w of warnings) console.log(w);
for (const e of errors) console.error(e);
console.log(`\ncontract-gate ${strict ? '(strict)' : '(fast)'}: ${errors.length} error(s), ${warnings.length} warning(s)`);
if (errors.length) {
  console.error('CONTRACT_GATE_FAILED');
  process.exit(2);
}
console.log('CONTRACT_GATE_PASSED');
