import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCAN_EXTENSIONS = new Set(['.js', '.py']);
const SCAN_ROOTS = ['src', 'scripts', 'benchmarks'];

const PATTERNS = Object.freeze([
  { id: 'banned-note', regex: /\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b/, serverOnly: false },
  { id: 'not-implemented', regex: /notimplemented/i, serverOnly: false },
  { id: 'dummy-data', regex: /\bdummy\b/i, serverOnly: false },
  { id: 'faker', regex: /\bfaker\b/i, serverOnly: false },
  { id: 'hardcoded-output', regex: /hard-?coded[ -_]?(output|answer|result|evidence|receipt|proof)/i, serverOnly: false },
  { id: 'demo-only', regex: /demo[ -_]?only/i, serverOnly: false },
  { id: 'mock-result', regex: /mock[ -_]?(result|data|response|success|receipt|proof)/i, serverOnly: false },
  { id: 'sleep-sync', regex: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|time\.sleep\s*\(/ },
  { id: 'random-evidence', regex: /\bMath\.random\b|\brandom\.(random|randint|choice|uniform)\b/ },
  { id: 'catch-all-success', regex: null },
  { id: 'silent-fallback', regex: null }
]);

const ALLOWLIST = Object.freeze([
  { pattern: 'sleep-sync', file: 'src/app.js', justification: 'Browser toast/object-URL timers; UI scheduling, never evidence synchronization.' },
  { pattern: 'sleep-sync', file: 'src/site-redesign.js', signature: 'var poll = window.setInterval(function () {', justification: 'Temporary browser bootstrap poll until the SPA API exists; bounded and not used for migration proof.' },
  { pattern: 'sleep-sync', file: 'src/site-redesign.js', signature: 'window.setTimeout(function () { window.clearInterval(poll); }, 15000);', justification: 'Hard stop for the bootstrap UI polling timer; never synchronization of transaction evidence.' },
  { pattern: 'sleep-sync', file: 'src/studio-flow.js', signature: 'if (should && !poll) poll = window.setInterval(schedule, 400);', justification: 'Refreshes only the running-process progress view from canonical state; not run completion evidence.' },
  { pattern: 'sleep-sync', file: 'src/studio-flow.js', signature: 'setNotice.timer = window.setTimeout(() => { notice = null; schedule(); }, 5000);', justification: 'Expires transient browser notification text; does not change transaction state.' },
  { pattern: 'sleep-sync', file: 'src/studio-flow.js', signature: 'window.setTimeout(() => URL.revokeObjectURL(url), 1000);', justification: 'Releases a temporary browser CSV download Object URL after the click; not receipt/commit signaling.' },
  { pattern: 'sleep-sync', file: 'src/studio-flow.js', signature: 'const bootPoll = window.setInterval(() => {', justification: 'Temporary browser startup readiness poll, only schedules view redraws.' },
  { pattern: 'sleep-sync', file: 'src/studio-flow.js', signature: 'window.setTimeout(() => window.clearInterval(bootPoll), 15000);', justification: 'Hard deadline to stop transient UI bootstrap polling, not a migration completion gate.' },
  { pattern: 'sleep-sync', file: 'src/worker/migration.worker.js', justification: 'Browser worker event-loop yield and pause polling; UI scheduling only.' },
  { pattern: 'sleep-sync', file: 'src/runtime/browser-worker-runtime.js', justification: 'Browser pause timer; UI scheduling only.' },
  { pattern: 'random-evidence', file: 'src/core/state-machine.js', justification: 'Client-side job label suffix; never part of any evidence chain (evidence uses sha256Canonical).' },
  { pattern: 'sleep-sync', file: 'scripts/browser-smoke.py', justification: 'Bounded test polling helper (wait_for with timeout) for browser smoke; CI test synchronization, not production evidence.' },
  { pattern: 'sleep-sync', file: 'scripts/qualify-browser-ui.py', signature: 'time.sleep(.1)', justification: 'Bounded retry after an actual stale Chrome DOM node; successful file selection is never repeated or inferred from elapsed time.' },
  { pattern: 'sleep-sync', file: 'scripts/measure-local-process.py', signature: 'time.sleep(.25)', justification: 'Spaces read-only process memory, CPU and marked fixture disk samples; raw observations are retained and no pass depends on waiting.' },
  { pattern: 'sleep-sync', file: 'scripts/qualify-sqlite-production.js', signature: 'const timer = setInterval(() => { heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed); }, 100);', justification: 'Samples actual child V8 heap during native migration; timer does not advance checkpoints or fabricate completion.' },
  { pattern: 'sleep-sync', file: 'scripts/qualify-sqlite-production.js', signature: 'const timeout = setTimeout(() => { callbackError = new Error(\'Native qualification child exceeded ten minutes\'); child.kill(\'SIGKILL\'); }, 600000);', justification: 'Hard watchdog terminates a stuck disposable child and fails qualification, never granting success.' },
  { pattern: 'sleep-sync', file: 'scripts/qualify-sqlite-production.js', signature: 'while (Date.now() <= execution.lease.expiresAtMs) await new Promise(resolve => setTimeout(resolve, 10));', justification: 'Waits for independently read actual lease expiry before real competing acquisition and native stale-fence refusal.' },
  { pattern: 'sleep-sync', file: 'scripts/qualify-sqlite-production.js', signature: 'if (!partial) await new Promise(resolve => setTimeout(resolve, 20));', justification: 'Bounded filesystem polling discovers a real partially written snapshot before actual OS process termination.' },
  { pattern: 'sleep-sync', file: 'scripts/qualify-sqlite-production.js', signature: 'while (Date.now() <= lease.expires_at_ms) await new Promise(resolve => setTimeout(resolve, 100));', justification: 'Waits for native SQLite lease expiry read from the target before actual process restart/takeover; success requires row and ledger assertions.' },
  { pattern: 'sleep-sync', file: 'scripts/qualify-postgres-materialization.js', justification: 'Peak-RSS sampler interval (unref timer) for load measurement; observability, not synchronization.' },
  { pattern: 'sleep-sync', file: 'src/connectors/postgres/reference.js', justification: 'Bounded WAL LSN-advance wait with an explicit deadline for CDC recovery tests; wait loop only, never evidence.' },
  { pattern: 'not-implemented', file: 'scripts/production-purity.js', justification: 'Pattern vocabulary defining this gate itself, not an unimplemented path.' },
  { pattern: 'dummy-data', file: 'scripts/production-purity.js', justification: 'Pattern vocabulary defining this gate itself, not dummy data.' },
  { pattern: 'faker', file: 'scripts/production-purity.js', justification: 'Pattern vocabulary defining this gate itself, not fabricated data.' },
  { pattern: 'hardcoded-output', file: 'scripts/production-purity.js', justification: 'Pattern vocabulary defining this gate itself, not hard-coded output.' },
  { pattern: 'demo-only', file: 'scripts/production-purity.js', justification: 'Pattern vocabulary defining this gate itself, not a demo-only branch.' },
  { pattern: 'mock-result', file: 'scripts/production-purity.js', justification: 'Pattern vocabulary defining this gate itself, not a mock result.' },
  { pattern: 'silent-fallback', file: 'scripts/production-purity.js', justification: 'Pattern vocabulary defining this gate itself, not fallback logic.' },
  { pattern: 'catch-all-success', file: 'scripts/production-purity.js', justification: 'Pattern vocabulary defining this gate itself, not a swallowed error.' }
]);

function stripLineComments(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
  return line;
}

function removeStringLiterals(line) {
  return line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
}

function catchBlockAt(lines, index) {
  const first = lines[index].slice(lines[index].indexOf('catch'));
  let started = false;
  let depth = 0;
  const body = [];
  const feed = line => {
    for (const char of line) {
      if (!started) {
        if (char === '{') { started = true; depth = 1; }
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return true;
      }
    }
    return false;
  };
  for (let cursor = index; cursor < lines.length; cursor += 1) {
    const line = cursor === index ? first : lines[cursor];
    if (started) body.push(lines[cursor]);
    if (feed(line)) return body.join('\n');
    if (body.join('\n').length > 2000) return body.join('\n');
  }
  return body.join('\n');
}

function catchAllSuccessLines(lines) {
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/\bcatch\b/.test(lines[index])) continue;
    const block = catchBlockAt(lines, index);
    const hasSuccessReturn = /return\s+true\b/.test(block) || /return\s*\{[^}]{0,200}\b(ok|success)\s*:\s*true/.test(block);
    const rethrows = /\bthrow\b/.test(block);
    if (hasSuccessReturn && !rethrows) hits.push(index + 1);
  }
  return hits;
}

const FALLBACK_SHAPES = /\|\|\s*[a-zA-Z_$][a-zA-Z0-9_$]*[Ff]allback|\?\?\s*[a-zA-Z_$][a-zA-Z0-9_$]*[Ff]allback|\b[a-zA-Z_$][a-zA-Z0-9_$]*(Fallback|FALLBACK)\b|\bfallback(To|From|Rows|Data|Value|Values|Path|File|Dir|Url|Host|Plan)\b|useFallback|withFallback|orFallback|setFallback|getFallback|loadFallback/;

function silentFallbackLines(lines) {
  const hits = [];
  lines.forEach((line, index) => {
    const code = removeStringLiterals(stripLineComments(line));
    if (FALLBACK_SHAPES.test(code)) hits.push(index + 1);
  });
  return hits;
}

async function collectFiles(root) {
  const out = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(full);
      } else if (entry.isFile() && SCAN_EXTENSIONS.has(extname(entry.name))) {
        out.push(full);
      }
    }
  }
  for (const scanRoot of SCAN_ROOTS) {
    try {
      await walk(join(root, scanRoot));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return out.sort();
}

export async function scanProductionPurity({ root = process.cwd() } = {}) {
  const files = await collectFiles(root);
  const violations = [];
  for (const file of files) {
    const relative = file.slice(root.length).replace(/^[/\\]/, '').replaceAll('\\', '/');
    const extension = extname(file);
    const content = await readFile(file, 'utf8');
    const lines = content.split('\n');
    for (const pattern of PATTERNS) {
      if (pattern.id === 'catch-all-success') {
        for (const line of catchAllSuccessLines(lines)) violations.push({ file: relative, line, pattern: pattern.id });
        continue;
      }
      if (pattern.id === 'silent-fallback') {
        for (const line of silentFallbackLines(lines, extension)) violations.push({ file: relative, line, pattern: pattern.id });
        continue;
      }
      lines.forEach((line, index) => {
        const code = pattern.id === 'sleep-sync' ? removeStringLiterals(stripLineComments(line)) : line;
        if (pattern.regex.test(code)) violations.push({ file: relative, line: index + 1, pattern: pattern.id, statement: line.trim() });
      });
    }
  }
  const uncovered = violations.filter(hit => !ALLOWLIST.some(entry => entry.pattern === hit.pattern && hit.file === entry.file && (entry.signature === undefined || entry.signature === hit.statement)));
  return Object.freeze({
    filesScanned: files.length,
    violations: Object.freeze(violations),
    uncovered: Object.freeze(uncovered),
    ok: uncovered.length === 0
  });
}

export function stalePurityAllowlist(violations = []) {
  return Object.freeze(ALLOWLIST.filter(entry => !violations.some(hit => hit.pattern === entry.pattern && hit.file === entry.file && (entry.signature === undefined || entry.signature === hit.statement))));
}

export function allowlistedPurity() {
  return ALLOWLIST;
}

async function main() {
  const report = await scanProductionPurity({});
  const stale = stalePurityAllowlist(report.violations);
  if (!report.ok || stale.length > 0) {
    process.stderr.write(`production purity gate failed: ${report.uncovered.length} uncovered violations, ${stale.length} stale allowlist entries\n`);
    for (const hit of report.uncovered) process.stderr.write(`  ${hit.file}:${hit.line} [${hit.pattern}]\n`);
    for (const entry of stale) process.stderr.write(`  stale allowlist: ${entry.file} [${entry.pattern}]\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`production purity gate passed (${report.filesScanned} files, ${report.violations.length} allowlisted matches)\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) await main();
