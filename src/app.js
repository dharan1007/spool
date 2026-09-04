import { CommandKernel } from './core/command-kernel.js';
import { PHASES } from './core/state-machine.js';
import { createDemoCsv } from './core/demo.js';
import { IndexedDbWorkspaceStore } from './storage/indexeddb.js';
import { BrowserWorkerRuntime } from './runtime/browser-worker-runtime.js';
import { toolNamesForPhase } from './webmcp/registry.js';
import { initializeOptionalWebMcp } from './webmcp/optional.js';

const ROUTES = Object.freeze([
  '/', '/autopilot', '/how-it-works', '/webmcp', '/benchmarks', '/docs',
  '/studio', '/studio/new', '/studio/mission', '/studio/results'
]);

const PUBLIC_NAV = [
  ['/', 'Overview'],
  ['/autopilot', 'Autopilot'],
  ['/how-it-works', 'How it works'],
  ['/webmcp', 'WebMCP'],
  ['/benchmarks', 'Benchmarks'],
  ['/docs', 'Docs']
];

const OUTCOMES = Object.freeze([
  {
    id: 'database_ready',
    title: 'Database-ready',
    eyebrow: 'Recommended',
    copy: 'Normalize field names, promote strongly evidenced types, validate every output row, and keep dirty exceptions separate.'
  },
  {
    id: 'clean_standardize',
    title: 'Clean & standardize',
    eyebrow: 'Conservative',
    copy: 'Normalize names and whitespace while preserving the source field types. Best when the existing contract is already trusted.'
  },
  {
    id: 'preserve_contract',
    title: 'Preserve contract',
    eyebrow: 'Minimal change',
    copy: 'Keep source field names and types, but run deterministic validation, checkpointing, quality grouping, and safe export.'
  }
]);

const store = new IndexedDbWorkspaceStore();
const runtime = new BrowserWorkerRuntime();
const appRoot = document.getElementById('app-root');
let selectedOutcome = 'database_ready';
let latestState = null;
let webMcpStatus = 'Checking browser support';
let nativeRegistry = null;
let registryChain = Promise.resolve();
let renderQueued = false;

const kernel = new CommandKernel({
  store,
  runtime,
  onStateChange(state) {
    latestState = state;
    scheduleRender();
    registryChain = registryChain
      .then(() => nativeRegistry?.sync(state.job.phase))
      .catch(() => { webMcpStatus = 'WebMCP registration unavailable'; scheduleRender(); });
  }
});

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}
function number(value) { return new Intl.NumberFormat('en-US').format(Number(value ?? 0)); }
function percent(value, total) { return total ? `${((value / total) * 100).toFixed(1)}%` : '0%'; }
function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value; let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}
function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString();
}
function currentPath() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  return ROUTES.includes(path) ? path : path;
}
function phaseTone(phase) {
  if (phase === PHASES.COMPLETE) return 'success';
  if ([PHASES.FAILED, PHASES.ABORTED].includes(phase)) return 'danger';
  if ([PHASES.RUNNING, PHASES.REPLAYING].includes(phase)) return 'running';
  if ([PHASES.PAUSED, PHASES.PAUSED_RECOVERED].includes(phase)) return 'warning';
  return 'neutral';
}
function missionStatus(state) {
  return state?.mission?.status ?? (state?.source ? 'SOURCE_READY' : 'NOT_STARTED');
}
function missionHeadline(status) {
  return ({
    NOT_STARTED: 'No migration running',
    SOURCE_READY: 'Source ready for Autopilot',
    PLANNING: 'Planning the migration',
    RUNNING: 'SPOOL is migrating your data',
    RECOVERING: 'Recovering from the last checkpoint',
    NEEDS_ATTENTION: 'A decision needs your attention',
    COMPLETE: 'Migration complete',
    FAILED: 'Migration stopped safely',
    ABORTED: 'Migration aborted'
  })[status] ?? status;
}

function navigate(path) {
  if (!ROUTES.includes(path)) path = '/';
  if (window.location.pathname !== path) window.history.pushState({}, '', path);
  window.scrollTo({ top: 0, behavior: 'instant' });
  render();
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => { renderQueued = false; render(); });
}

function topbar(path, state) {
  const phase = state?.job?.phase ?? PHASES.EMPTY;
  return `<header class="topbar">
    <a class="brand" href="/" data-route="/" aria-label="SPOOL overview">
      <span class="brand-mark">S</span>
      <span class="brand-word"><strong>SPOOL</strong><small>Autopilot migrations</small></span>
    </a>
    <nav class="primary-nav" aria-label="Primary navigation">
      ${PUBLIC_NAV.map(([href, label]) => `<a href="${href}" data-route="${href}" class="${path === href ? 'active' : ''}">${label}</a>`).join('')}
    </nav>
    <div class="top-actions">
      <span class="status-pill ${phaseTone(phase)}"><i></i>${esc(phase)}</span>
      <a class="button secondary compact" href="/studio" data-route="/studio">Open Studio</a>
    </div>
  </header>`;
}

function shell(path, body, state, { studio = false } = {}) {
  return `${topbar(path, state)}
    ${studio ? studioRail(path, state) : ''}
    <main class="${studio ? 'studio-main' : 'site-main'}">${body}</main>
    <footer class="footer">
      <div><strong>SPOOL</strong><span>Local-first deterministic migration infrastructure.</span></div>
      <div><span>Dataset plane: browser-local</span><span>Network: disabled by CSP</span><span>Transform IR: constrained</span></div>
    </footer>
    <div id="toast" class="toast" role="status" aria-live="polite"></div>`;
}

function studioRail(path, state) {
  const hasSource = Boolean(state?.source);
  const complete = state?.job?.phase === PHASES.COMPLETE;
  const items = [
    ['/studio', 'Workspace', true],
    ['/studio/new', 'New migration', true],
    ['/studio/mission', 'Mission', hasSource],
    ['/studio/results', 'Results', complete]
  ];
  return `<aside class="studio-rail" aria-label="Studio navigation">
    <div class="rail-label">Studio</div>
    ${items.map(([href, label, enabled]) => enabled
      ? `<a href="${href}" data-route="${href}" class="${path === href ? 'active' : ''}">${label}</a>`
      : `<span class="rail-disabled">${label}</span>`).join('')}
  </aside>`;
}

function heroBadge(text) { return `<span class="eyebrow-chip">${esc(text)}</span>`; }
function arrowIcon() { return '<span aria-hidden="true">→</span>'; }

function overviewPage(state) {
  return shell('/', `
    <section class="hero hero-grid">
      <div class="hero-copy">
        ${heroBadge('Local-first · deterministic · WebMCP-native')}
        <h1>Turn a messy CSV into a <em>verified data contract</em> without babysitting the workflow.</h1>
        <p class="lede">SPOOL profiles the source, infers a safe target schema, builds deterministic transforms, dry-runs them, executes in a Worker, groups bad rows, recovers from checkpoints, and exposes only the agent tools that make sense right now.</p>
        <div class="hero-actions">
          <a href="/studio/new" data-route="/studio/new" class="button primary">Start a migration ${arrowIcon()}</a>
          <a href="/how-it-works" data-route="/how-it-works" class="button secondary">See the workflow</a>
        </div>
        <div class="trust-line"><span><b>01</b> Your rows stay in-browser</span><span><b>02</b> No arbitrary generated code</span><span><b>03</b> Pause/recovery is durable</span></div>
      </div>
      <div class="hero-visual" aria-label="SPOOL workflow preview">
        <div class="visual-top"><span>customer-export.csv</span><span class="status-pill running"><i></i>Autopilot</span></div>
        <div class="transform-preview">
          <div class="data-column"><small>SOURCE</small><code>Customer ID</code><code>monthly_fee</code><code>joined</code><code>is_active</code></div>
          <div class="transform-column"><small>PLAN</small><span>normalize</span><span>number</span><span>date</span><span>boolean</span></div>
          <div class="data-column target"><small>TARGET</small><code>customer_id</code><code>monthly_fee</code><code>joined</code><code>is_active</code></div>
        </div>
        <div class="visual-progress"><div><span>Validated plan</span><strong>99.0% inference confidence</strong></div><div class="progress"><i style="width:84%"></i></div><div class="visual-stats"><span>25,000 rows</span><span>typed output</span><span>checkpointed</span></div></div>
      </div>
    </section>

    <section class="section problem-section">
      <div class="section-heading narrow"><span class="kicker">THE PROBLEM</span><h2>Migration tools usually make the operator carry the procedure.</h2><p>A person or agent has to remember the schema step, mapping step, preview step, validation step, execution step, failure handling, replay rules and export rules. SPOOL makes the website own that procedural state.</p></div>
      <div class="comparison-grid">
        <article class="comparison-card muted"><span class="card-index">Traditional</span><h3>Operator orchestration</h3><ol><li>Inspect file</li><li>Define every target field</li><li>Map every source</li><li>Remember which actions are legal</li><li>Watch the run</li><li>Recover failures manually</li></ol></article>
        <article class="comparison-card accent"><span class="card-index">SPOOL</span><h3>Site-owned orchestration</h3><ol><li>Add the source</li><li>Choose the desired outcome</li><li>Run Autopilot</li><li>Answer only real ambiguity</li><li>Receive verified output</li></ol></article>
      </div>
    </section>

    <section class="section workflow-section">
      <div class="section-heading"><span class="kicker">HOW IT MOVES</span><h2>One visible journey. The complexity stays underneath.</h2><p>The default product flow is intentionally smaller than the engine that powers it.</p></div>
      <div class="step-flow">
        ${[
          ['01','Add source','CSV is parsed locally and fingerprinted before active work is replaced.'],
          ['02','Choose outcome','Database-ready, clean & standardize, or preserve the existing contract.'],
          ['03','Autopilot plans','Schema inference, confidence evidence, transform IR and a real dry-run.'],
          ['04','SPOOL executes','Worker batches, typed validation, checkpoints and grouped violations.'],
          ['05','Review only exceptions','If a choice is destructive or ambiguous, SPOOL stops and shows only that decision.'],
          ['06','Export verified output','CSV/JSON plus quality counts, revision identity and lineage.']
        ].map(([n,t,c]) => `<article class="step-card"><span>${n}</span><h3>${t}</h3><p>${c}</p></article>`).join('')}
      </div>
    </section>

    <section class="section proof-section">
      <div class="proof-panel">
        <div><span class="kicker">WHY WEBMCP MATTERS</span><h2>The tool catalog changes with the workflow.</h2><p>Instead of giving an agent a permanent wall of commands, SPOOL registers only phase-valid capabilities. The UI and agent calls share the same command kernel.</p><a href="/webmcp" data-route="/webmcp" class="text-link">Explore Temporal WebMCP ${arrowIcon()}</a></div>
        <div class="topology-demo"><div><small>SOURCE_READY</small><code>inspect_source_schema</code><code>run_autopilot</code><code>inspect_mission</code></div><span class="topology-arrow">→</span><div><small>RUNNING</small><code>inspect_mission</code><code>get_run_state</code><code>pause_run</code></div></div>
      </div>
    </section>

    <section class="section final-cta"><span class="kicker">READY WHEN YOU ARE</span><h2>Give SPOOL a file and an outcome. Let the site carry the workflow.</h2><a href="/studio/new" data-route="/studio/new" class="button primary large">Open Studio ${arrowIcon()}</a></section>
  `, state);
}

function autopilotPage(state) {
  const stages = [
    ['PROFILE', 'Understand the source', 'Field types, nullability, representative values, parseability and source fingerprint.'],
    ['INFER', 'Propose the clean contract', 'Names are normalized and strongly evidenced numeric/date/boolean fields can be promoted.'],
    ['PLAN', 'Build deterministic transforms', 'Every target is expressed as constrained transformation data, never generated JavaScript.'],
    ['DRY RUN', 'Test the real engine', 'A bounded sample goes through the same transform and typed validation path as the full run.'],
    ['ASSESS', 'Decide whether it is safe', 'Confident changes continue. Destructive ambiguity becomes a small decision instead of a silent guess.'],
    ['EXECUTE', 'Run with checkpoints', 'Worker batches update durable progress, grouped violations and output revision state.'],
    ['VERIFY', 'Close the loop', 'Processed, valid, invalid, revision and export identity are checked before the result is presented.']
  ];
  return shell('/autopilot', `
    <section class="page-hero compact-hero"><div>${heroBadge('AUTOPILOT')}<h1>The user states the outcome. <em>SPOOL owns the procedure.</em></h1><p>Autopilot is not a script that clicks the old UI. It is a kernel-level orchestration path that plans, dry-runs and starts the migration through the same deterministic commands used everywhere else.</p><a href="/studio/new" data-route="/studio/new" class="button primary">Run Autopilot ${arrowIcon()}</a></div><div class="mission-mini"><small>DEFAULT HAPPY PATH</small><code>Add source</code><span>↓</span><code>Choose Database-ready</code><span>↓</span><code>Run Autopilot</code><span>↓</span><strong>No action required</strong></div></section>
    <section class="section"><div class="section-heading"><span class="kicker">THE PIPELINE</span><h2>Seven internal stages, one primary action.</h2></div><div class="pipeline-list">${stages.map(([name,title,copy],i) => `<article><span class="pipeline-number">${String(i+1).padStart(2,'0')}</span><div><small>${name}</small><h3>${title}</h3><p>${copy}</p></div></article>`).join('')}</div></section>
    <section class="section split-section"><div><span class="kicker">SAFE AUTOMATION</span><h2>Automatic does not mean reckless.</h2><p>SPOOL only advances when the target and transform plan satisfy deterministic safety rules. Strong parseability evidence can promote a dirty string field to a type while rows that fail that contract are rejected into quality groups.</p></div><div class="decision-grid"><article class="decision safe"><span>CONTINUE AUTOMATICALLY</span><h3>Lossless / strongly evidenced</h3><p>Whitespace trim, normalized identifiers, obvious booleans, strongly parseable numbers and ISO dates.</p></article><article class="decision stop"><span>NEEDS ATTENTION</span><h3>Destructive / ambiguous</h3><p>Name collisions, multiple equally plausible interpretations, or a plan that cannot satisfy the typed target contract.</p></article></div></section>
    <section class="section"><div class="callout"><div><span class="kicker">EVIDENCE, NOT MAGIC</span><h2>Every inferred field carries provenance.</h2></div><pre class="code-panel">target field: monthly_fee\ninferred type: number\nconfidence: 0.9900\nevidence: 99 / 100 sampled values parse\ndecision: automatic</pre></div></section>
  `, state);
}

function howItWorksPage(state) {
  const steps = [
    ['Drop the CSV', 'The parser handles quoted CSV, rejects unsafe/duplicate headers and fingerprints the candidate before replacing active work.', 'Source remains local'],
    ['Pick an outcome', 'Most migrations should use Database-ready. Conservative modes remain available when source semantics must be preserved.', 'One decision'],
    ['Autopilot profiles', 'SPOOL examines schema and bounded evidence to understand what each field can safely become.', 'Evidence captured'],
    ['A deterministic plan is created', 'Target contract + transform IR are validated before execution. Unknown operators and unsafe regex patterns are rejected.', 'No arbitrary code'],
    ['The same engine dry-runs', 'Preview is not a fake UI sample; it uses the real transform compiler and target validator.', 'Same execution path'],
    ['Worker execution starts', 'Rows move in bounded batches with job ID, mapping revision and monotonically increasing worker sequence checks.', 'Checkpointed'],
    ['Only exceptions interrupt', 'If the planner finds a destructive ambiguity, the mission stops safely. Otherwise the UI says No action required.', 'Fail closed'],
    ['Output is verified and exported', 'Valid rows, rejected rows, quality groups and mapping revision are presented together before CSV/JSON export.', 'Lineage retained']
  ];
  return shell('/how-it-works', `
    <section class="page-hero text-hero">${heroBadge('END-TO-END')}<h1>How SPOOL works.</h1><p>Every screen corresponds to a real runtime boundary. Nothing in the visible workflow is a decorative simulation of a different backend.</p></section>
    <section class="section journey"><div class="journey-line"></div>${steps.map(([title,copy,tag],i) => `<article class="journey-step"><span class="journey-dot">${i+1}</span><div><span class="mini-tag">${tag}</span><h2>${title}</h2><p>${copy}</p></div></article>`).join('')}</section>
    <section class="section"><div class="architecture-card"><div><span class="kicker">ARCHITECTURE</span><h2>One mutation path.</h2><p>Human controls, Autopilot and WebMCP all converge on the Command Kernel. The kernel owns the phase machine, revisions, persistence and Worker lifecycle.</p></div><div class="architecture-diagram"><span>Human UI</span><span>Autopilot</span><span>WebMCP</span><strong>Command Kernel</strong><span>IndexedDB</span><span>Worker runtime</span><span>Safe transform IR</span></div></div></section>
  `, state);
}

function webMcpPage(state) {
  const tools = toolNamesForPhase(state.job.phase);
  return shell('/webmcp', `
    <section class="page-hero compact-hero"><div>${heroBadge('TEMPORAL WEBMCP')}<h1>Capability discovery is part of <em>workflow state.</em></h1><p>Most agent interfaces publish a permanent command catalog. SPOOL binds capability availability to the durable migration phase so stale actions disappear instead of relying on the model to remember they are illegal.</p></div><div class="metric-stack"><article><span>Current phase</span><strong>${esc(state.job.phase)}</strong></article><article><span>Active tools now</span><strong>${tools.length}</strong></article><article><span>Native browser API</span><strong>${esc(webMcpStatus)}</strong></article></div></section>
    <section class="section"><div class="section-heading"><span class="kicker">LIVE TOPOLOGY</span><h2>What an agent can do on this workspace right now.</h2><p>The list below is derived from the same registry that is synchronized with <code>document.modelContext.registerTool()</code> when the browser implements WebMCP.</p></div><div class="tool-grid">${tools.map(name => `<article class="tool-card"><span>AVAILABLE</span><code>${esc(name)}</code><p>${toolCopy(name)}</p></article>`).join('') || '<div class="empty-panel">No tools registered for this phase.</div>'}</div></section>
    <section class="section split-section"><div><span class="kicker">STATE CONTRACT</span><h2>A tool is meaningful only inside a valid revision context.</h2><p>SPOOL envelopes every command result with phase, job identity, mapping revision and valid next actions. Stale registrations are aborted when phase changes.</p></div><pre class="code-panel">capability: run_autopilot\nvalid when: SOURCE_READY\nsource fingerprint: bound to workspace\nallowed effect: plan + validate + execute\ninvalidation: phase or source changes\nrecovery: inspect_mission</pre></section>
    <section class="section"><div class="proof-panel"><div><span class="kicker">WHY THIS REDUCES AGENT BURDEN</span><h2>The website remembers the procedure.</h2><p>The agent can express intent through <code>run_autopilot</code> rather than manually carrying target/mapping/preview/run sequencing in conversation context. Granular tools remain available for advanced control.</p></div><div class="sequence"><code>inspect_workspace</code><span>→</span><code>run_autopilot</code><span>→</span><code>inspect_mission</code><span>→</span><code>export_csv</code></div></div></section>
  `, state);
}

function toolCopy(name) {
  const copies = {
    run_autopilot: 'Plan, dry-run and start a safe migration from the loaded source.',
    inspect_mission: 'Read bounded Autopilot evidence, ambiguity, progress and quality state.',
    inspect_workspace: 'Read workflow metadata without dumping source or output rows.',
    inspect_source_schema: 'Read inferred source types and nullability.',
    inspect_source_sample: 'Read a bounded sample of untrusted user data.',
    pause_run: 'Request a durable acknowledged Worker checkpoint.',
    resume_run: 'Continue from checkpoint or replay when a mapping revision changed.',
    get_run_state: 'Read durable progress and recovery metadata.',
    inspect_violations: 'Read grouped quality problems with bounded samples.',
    inspect_result: 'Read a bounded completed output sample.',
    inspect_quality_report: 'Read processed/valid/invalid and violation totals.',
    export_csv: 'Produce spreadsheet-injection-neutralized CSV.',
    export_json: 'Produce completed output JSON.'
  };
  return copies[name] ?? 'A phase-valid command delegated to the shared SPOOL kernel.';
}

function benchmarksPage(state) {
  return shell('/benchmarks', `
    <section class="page-hero text-hero">${heroBadge('MEASURED EVIDENCE')}<h1>Benchmarks without invented claims.</h1><p>SPOOL reports deterministic engine throughput and serialized tool-definition measurements. It does not convert those measurements into unsupported universal LLM-success claims.</p></section>
    <section class="section"><div class="benchmark-grid"><article class="benchmark-hero"><span>50K ROW REFERENCE RUN</span><strong>199,519</strong><small>transformed + validated rows/sec</small><p>Stored release reference from Linux x64 / Node 22.16. Timing is regenerated by the release benchmark and varies by environment.</p></article><article><span>Temporal tool reduction</span><strong>79.3%</strong><small>average active tool-count reduction</small></article><article><span>Definition surface</span><strong>79.2%</strong><small>average serialized definition-byte reduction</small></article><article><span>Safety plane</span><strong>0</strong><small>dataset network endpoints required</small></article></div></section>
    <section class="section"><div class="section-heading"><span class="kicker">METHODOLOGY</span><h2>What those numbers actually measure.</h2></div><div class="method-grid"><article><h3>Migration engine</h3><p>Generated dirty customer rows are parsed, transformed through the constrained IR and validated against the target schema. Throughput covers transform + target validation.</p></article><article><h3>Temporal WebMCP</h3><p>The benchmark serializes the permanent tool catalog and each phase-valid catalog, then compares active tool count and definition bytes.</p></article><article><h3>What is not claimed</h3><p>No universal token savings, model accuracy or agent completion rate is claimed unless an actual controlled agent experiment has been run.</p></article></div></section>
    <section class="section"><div class="callout"><div><span class="kicker">NEXT EMPIRICAL GATE</span><h2>Flat-vs-temporal agent evaluation.</h2><p>The strongest next experiment is the same migration mission under a permanent tool catalog versus the state-dependent catalog, measuring completion rate, wrong-phase calls, total calls, recovery actions and human interventions.</p></div></div></section>
  `, state);
}

function docsPage(state) {
  return shell('/docs', `
    <section class="page-hero text-hero">${heroBadge('PRODUCT + ENGINE DOCS')}<h1>Enough explanation to understand the system before touching Advanced.</h1><p>The default Studio is intentionally small. This page documents what happens underneath it.</p></section>
    <section class="section docs-layout"><nav class="docs-nav"><a href="#privacy">Privacy</a><a href="#ir">Transform IR</a><a href="#recovery">Recovery</a><a href="#quality">Quality</a><a href="#limits">Limits</a><a href="#webmcp-doc">WebMCP</a></nav><div class="docs-content">
      <article id="privacy"><span class="kicker">PRIVACY</span><h2>Browser-local data plane</h2><p>CSV rows are parsed and transformed in the browser. Production CSP sets <code>connect-src 'none'</code>, so the application source has no dataset API, analytics transport, WebSocket or beacon path.</p></article>
      <article id="ir"><span class="kicker">TRANSFORM IR</span><h2>Generated transformations are data, not executable code</h2><p>Supported expressions include field/literal, trim, casing, number/boolean casts, date parsing, enum maps, coalesce, concat, conditional logic, bounded regex replacement and arithmetic. Unknown operators are rejected. <code>eval</code> and <code>Function</code> are prohibited.</p></article>
      <article id="recovery"><span class="kicker">RECOVERY</span><h2>Checkpoint identity is part of the workflow</h2><p>Worker events are scoped by job ID, mapping revision and strictly increasing sequence. Manual interrupted runs become explicitly recoverable. Autopilot interrupted runs resume from their durable checkpoint when the workspace invariants still match.</p></article>
      <article id="quality"><span class="kicker">QUALITY</span><h2>Invalid rows are grouped, not hidden</h2><p>Every transformed row is validated against the typed target contract. Invalid rows do not silently enter the output. Violation classes keep bounded samples so agents and humans can inspect problems without returning unbounded raw error volume.</p></article>
      <article id="limits"><span class="kicker">LIMITS</span><h2>Current engine boundaries</h2><p>Input is CSV and output is CSV/JSON. The parser enforces hard column, row and cell limits. The current implementation stores source rows in IndexedDB chunks and executes bounded Worker batches; whole-source streaming/OPFS remains a future scale step rather than a fake claim.</p></article>
      <article id="webmcp-doc"><span class="kicker">WEBMCP</span><h2>One command kernel</h2><p>Native WebMCP tools call the same <code>CommandKernel.invoke()</code> used by the interface. There is no agent-only mutation path. The registered set changes when the job phase changes, and stale registrations are aborted.</p></article>
    </div></section>
  `, state);
}

function sourceSummary(state) {
  if (!state.source) return '<div class="empty-panel"><strong>No source loaded</strong><p>Open New migration to add a CSV or use the deterministic 25k-row example.</p></div>';
  return `<div class="source-summary-card"><div><span class="file-icon">CSV</span><div><strong>${esc(state.source.fileName)}</strong><p>${number(state.source.rows.length)} rows · ${number(state.source.headers.length)} fields · ${bytes(state.source.bytes)}</p></div></div><span class="status-pill success"><i></i>Fingerprint ready</span></div>`;
}

function studioDashboard(state) {
  const status = missionStatus(state);
  const hasSource = Boolean(state.source);
  return shell('/studio', `
    <section class="studio-heading"><div><span class="kicker">LOCAL WORKSPACE</span><h1>Migration Studio</h1><p>One durable active workspace. SPOOL restores the current mission from IndexedDB when this browser returns.</p></div><a href="/studio/new" data-route="/studio/new" class="button primary">${hasSource ? 'Replace / start new source' : 'New migration'} ${arrowIcon()}</a></section>
    <section class="studio-grid">
      <article class="studio-card wide"><div class="card-head"><div><span class="kicker">CURRENT MISSION</span><h2>${esc(missionHeadline(status))}</h2></div><span class="status-pill ${phaseTone(state.job.phase)}"><i></i>${esc(status)}</span></div>${sourceSummary(state)}${hasSource ? missionMiniStats(state) : ''}<div class="card-actions">${hasSource ? `<a href="/studio/mission" data-route="/studio/mission" class="button secondary">Open mission</a>` : `<a href="/studio/new" data-route="/studio/new" class="button secondary">Add source</a>`}${state.job.phase === PHASES.COMPLETE ? `<a href="/studio/results" data-route="/studio/results" class="button primary">View results</a>` : ''}</div></article>
      <article class="studio-card"><span class="kicker">AUTOMATION CONTRACT</span><h2>What SPOOL does for you</h2><ul class="check-list"><li>Profile the source</li><li>Infer target types with evidence</li><li>Generate deterministic mapping</li><li>Dry-run the real engine</li><li>Execute and checkpoint</li><li>Group exceptions</li><li>Verify final revision</li></ul></article>
      <article class="studio-card"><span class="kicker">PRIVACY STATUS</span><h2>Local data plane</h2><div class="status-list"><span><i class="dot success-dot"></i>connect-src 'none'</span><span><i class="dot success-dot"></i>No analytics transport</span><span><i class="dot success-dot"></i>Worker is same-origin</span><span><i class="dot success-dot"></i>Output stays local until export</span></div></article>
    </section>
  `, state, { studio: true });
}

function missionMiniStats(state) {
  return `<div class="mini-stats"><div><span>Processed</span><strong>${number(state.job.processedRows)} / ${number(state.job.totalRows)}</strong></div><div><span>Valid</span><strong>${number(state.job.validRows)}</strong></div><div><span>Invalid</span><strong>${number(state.job.invalidRows)}</strong></div><div><span>Mapping rev</span><strong>${number(state.mappingRevision)}</strong></div></div>`;
}

function newMigrationPage(state) {
  const source = state.source;
  const sourceReady = state.job.phase === PHASES.SOURCE_READY;
  const terminal = [PHASES.COMPLETE, PHASES.FAILED, PHASES.ABORTED].includes(state.job.phase);
  return shell('/studio/new', `
    <section class="studio-heading"><div><span class="kicker">NEW MIGRATION</span><h1>Source + outcome. That is the setup.</h1><p>SPOOL handles the schema, mapping, dry-run and execution unless it finds a genuinely unsafe ambiguity.</p></div>${terminal ? '<button class="button secondary" data-action="reset-workspace">Clear completed workspace</button>' : ''}</section>
    <section class="setup-layout">
      <article class="setup-card"><div class="setup-number">01</div><div class="card-head"><div><span class="kicker">SOURCE</span><h2>Add the CSV</h2></div>${source ? '<span class="status-pill success"><i></i>Loaded</span>' : ''}</div>
        <label class="dropzone" id="source-dropzone" tabindex="0">
          <input id="source-file" type="file" accept=".csv,text/csv" hidden>
          <span class="upload-mark">＋</span><strong>${source ? 'Replace source file' : 'Drop CSV here or choose a file'}</strong><p>The candidate is parsed and fingerprinted before active work is replaced.</p><span class="button secondary compact">Choose CSV</span>
        </label>
        <div class="or-line"><span>or</span></div>
        <button class="demo-row" data-action="load-demo"><span><strong>Try the 25k-row dirty customer example</strong><small>Includes bad dates and amounts so quality handling is visible.</small></span>${arrowIcon()}</button>
        ${source ? sourceSummary(state) : ''}
      </article>

      <article class="setup-card"><div class="setup-number">02</div><div class="card-head"><div><span class="kicker">OUTCOME</span><h2>What should SPOOL optimize for?</h2></div></div>
        <div class="outcome-list">${OUTCOMES.map(item => `<button class="outcome-option ${selectedOutcome === item.id ? 'selected' : ''}" data-outcome="${item.id}"><span><small>${item.eyebrow}</small><strong>${item.title}</strong><p>${item.copy}</p></span><i class="radio-dot"></i></button>`).join('')}</div>
      </article>

      <article class="launch-card"><div><span class="kicker">03 · AUTOPILOT</span><h2>${sourceReady ? 'Everything required is ready.' : 'Add a source to continue.'}</h2><p>${sourceReady ? 'SPOOL will profile, infer, plan, dry-run and execute. It stops only if a destructive ambiguity needs a decision.' : 'No target-schema form or mapping editor is required in the default workflow.'}</p></div><button class="button primary large" data-action="run-autopilot" ${sourceReady ? '' : 'disabled'}>Run Autopilot ${arrowIcon()}</button></article>
    </section>
  `, state, { studio: true });
}

function missionPage(state) {
  if (!state.source) return shell('/studio/mission', `<section class="studio-heading"><div><span class="kicker">MISSION</span><h1>No source loaded.</h1><p>Create a migration first.</p></div><a href="/studio/new" data-route="/studio/new" class="button primary">New migration</a></section>`, state, { studio: true });
  const mission = state.mission;
  const status = missionStatus(state);
  const progress = state.job.totalRows ? Math.min(100, (state.job.processedRows / state.job.totalRows) * 100) : 0;
  const evidence = mission?.evidence ?? [];
  const ambiguities = mission?.ambiguities ?? [];
  const active = [PHASES.RUNNING, PHASES.REPLAYING].includes(state.job.phase);
  const paused = [PHASES.PAUSED, PHASES.PAUSED_RECOVERED].includes(state.job.phase);
  const complete = state.job.phase === PHASES.COMPLETE;
  return shell('/studio/mission', `
    <section class="mission-header"><div><span class="kicker">MISSION · ${esc(mission?.outcome ?? 'not planned')}</span><h1>${esc(missionHeadline(status))}</h1><p>${status === 'RUNNING' ? 'No action required. You can leave this page; durable checkpoints protect progress and Autopilot resumes a valid interrupted mission when you return.' : status === 'NEEDS_ATTENTION' ? 'SPOOL refused to guess. Resolve the bounded ambiguity before execution.' : status === 'COMPLETE' ? 'The final output is tied to one mapping revision and the quality report is ready.' : 'Mission state is stored locally in this browser.'}</p></div><span class="status-pill ${phaseTone(state.job.phase)} large-pill"><i></i>${esc(status)}</span></section>

    ${status === 'NEEDS_ATTENTION' ? `<section class="attention-panel"><div><span class="kicker">REVIEW REQUIRED</span><h2>${ambiguities.length} decision${ambiguities.length === 1 ? '' : 's'} block automatic execution</h2><p>These choices can change the target contract destructively, so SPOOL fails closed instead of choosing silently.</p></div><div class="ambiguity-list">${ambiguities.map(item => `<article><span>${esc(item.code)}</span><h3>${esc(item.message)}</h3><p>Source fields: ${(item.sourceFields ?? []).map(esc).join(', ')}</p></article>`).join('')}</div><div class="attention-note">For this release, destructive name collisions require correcting the source headers before rerunning Autopilot. SPOOL will not invent a rename.</div></section>` : ''}

    <section class="mission-grid">
      <article class="mission-progress-card wide"><div class="card-head"><div><span class="kicker">EXECUTION</span><h2>${active ? 'Working automatically' : complete ? 'Execution finished' : paused ? 'Checkpoint paused' : 'Waiting to execute'}</h2></div><strong class="progress-number">${progress.toFixed(1)}%</strong></div><div class="progress large"><i style="width:${progress}%"></i></div>${missionMiniStats(state)}${active ? '<div class="no-action"><i></i><div><strong>No action required</strong><p>SPOOL is processing bounded Worker batches and persisting checkpoints.</p></div></div>' : ''}${paused ? '<button class="button primary" data-action="resume-run">Resume from checkpoint</button>' : ''}${complete ? '<a href="/studio/results" data-route="/studio/results" class="button primary">Open verified results →</a>' : ''}</article>
      <article class="mission-progress-card"><span class="kicker">PLAN CONFIDENCE</span><strong class="big-stat">${mission ? `${Math.round((mission.confidence ?? 0) * 100)}%` : '—'}</strong><p>Minimum recorded field-level inference confidence for the current Autopilot plan.</p></article>
      <article class="mission-progress-card"><span class="kicker">HUMAN INTERVENTIONS</span><strong class="big-stat">${number(mission?.interventions ?? 0)}</strong><p>SPOOL only increments this when automatic execution is blocked by explicit ambiguity.</p></article>
    </section>

    <section class="studio-section"><div class="section-heading"><span class="kicker">INFERENCE PROVENANCE</span><h2>Why SPOOL chose each target type.</h2><p>Evidence is bounded and metadata-focused; full source rows are not dumped into the mission inspector.</p></div><div class="evidence-table"><div class="evidence-head"><span>Source</span><span>Target</span><span>Type</span><span>Evidence</span><span>Decision</span></div>${evidence.length ? evidence.map(item => `<div class="evidence-row"><code>${esc(item.sourceField)}</code><code>${esc(item.targetField)}</code><span class="type-chip">${esc(item.inferredType)}</span><span>${number(item.successCount)} / ${number(item.sampleCount)} · ${Math.round((item.confidence ?? 0)*100)}%</span><span class="decision-chip">${esc(item.decision)}</span></div>`).join('') : '<div class="empty-panel">Run Autopilot to generate inference evidence.</div>'}</div></section>

    <section class="studio-section"><details class="advanced"><summary><span><small>POWER USER / EVALUATOR</small><strong>Advanced diagnostics</strong></span><span>Open</span></summary><div class="advanced-grid"><article><h3>Workflow identity</h3><dl>${diagRows(state)}</dl></article><article><h3>Active WebMCP tools</h3><div class="code-list">${toolNamesForPhase(state.job.phase).map(tool => `<code>${esc(tool)}</code>`).join('')}</div></article><article class="wide"><h3>Target contract</h3><pre>${esc(JSON.stringify(state.targetSchema, null, 2))}</pre></article><article class="wide"><h3>Transform IR</h3><pre>${esc(JSON.stringify(state.mapping, null, 2))}</pre></article><article class="wide"><h3>Mission metadata</h3><pre>${esc(JSON.stringify(mission ? { ...mission, evidence: mission.evidence?.slice(0, 30) } : null, null, 2))}</pre></article><div class="advanced-actions">${active ? '<button class="button secondary" data-action="pause-run">Pause safely</button>' : ''}${paused ? '<button class="button secondary" data-action="resume-run">Resume</button>' : ''}${(active || paused) ? '<button class="button danger" data-action="abort-run">Abort mission</button>' : ''}</div></div></details></section>
  `, state, { studio: true });
}

function diagRows(state) {
  const rows = [
    ['Job ID', state.job.jobId], ['Phase', state.job.phase], ['Source fingerprint', state.job.sourceFingerprint],
    ['Target revision', state.targetSchemaRevision], ['Mapping revision', state.mappingRevision],
    ['Checkpoint', state.job.checkpoint], ['Output revision', state.outputRevision], ['Updated', dateTime(state.updatedAt)]
  ];
  return rows.map(([key,value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value ?? '—')}</dd></div>`).join('');
}

function resultTable(rows, limit = 10) {
  const sample = rows.slice(0, limit);
  if (!sample.length) return '<div class="empty-panel">No valid output rows are available.</div>';
  const headers = Object.keys(sample[0]);
  return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${sample.map(row => `<tr>${headers.map(h => `<td>${esc(row[h])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function resultsPage(state) {
  if (state.job.phase !== PHASES.COMPLETE) return shell('/studio/results', `<section class="studio-heading"><div><span class="kicker">RESULTS</span><h1>No completed result yet.</h1><p>Finish a migration before exporting output.</p></div>${state.source ? '<a href="/studio/mission" data-route="/studio/mission" class="button primary">Open mission</a>' : '<a href="/studio/new" data-route="/studio/new" class="button primary">New migration</a>'}</section>`, state, { studio: true });
  const accepted = percent(state.job.validRows, state.job.processedRows);
  return shell('/studio/results', `
    <section class="result-hero"><div><span class="result-check">✓</span><div><span class="kicker">VERIFIED OUTPUT · REVISION ${state.outputRevision}</span><h1>Migration complete.</h1><p>${number(state.job.validRows)} rows satisfy the typed target contract. ${number(state.job.invalidRows)} rows were rejected into explicit quality groups rather than silently exported.</p></div></div><div class="export-actions"><button class="button secondary" data-action="export-json">Export JSON</button><button class="button primary" data-action="export-csv">Export CSV</button></div></section>
    <section class="result-metrics"><article><span>Processed</span><strong>${number(state.job.processedRows)}</strong></article><article><span>Valid output</span><strong>${number(state.job.validRows)}</strong></article><article><span>Rejected</span><strong>${number(state.job.invalidRows)}</strong></article><article><span>Acceptance</span><strong>${accepted}</strong></article></section>
    <section class="studio-section"><div class="section-heading"><span class="kicker">OUTPUT SAMPLE</span><h2>The actual transformed rows.</h2><p>Only valid rows appear in the result set. Export uses this same revision-locked output.</p></div>${resultTable(state.output, 12)}</section>
    <section class="studio-section"><div class="section-heading"><span class="kicker">QUALITY REPORT</span><h2>${state.violations.length ? 'Exceptions are explicit.' : 'No quality violations recorded.'}</h2></div><div class="quality-grid">${state.violations.length ? state.violations.map(group => `<article><span>${esc(group.code)}</span><strong>${number(group.count)}</strong><p>${esc(group.message)}</p><small>${number(group.samples?.length ?? 0)} bounded sample${group.samples?.length === 1 ? '' : 's'} retained</small></article>`).join('') : '<div class="empty-panel">Every processed row satisfied the target contract.</div>'}</div></section>
    <section class="studio-section"><div class="lineage-card"><div><span class="kicker">LINEAGE</span><h2>One result, one mapping revision.</h2><p>SPOOL records the source fingerprint, target revision, mapping revision, checkpoint progression and output revision used for this result.</p></div><dl>${diagRows(state)}</dl></div></section>
  `, state, { studio: true });
}

function notFoundPage(path, state) {
  return shell(path, `<section class="page-hero text-hero"><span class="kicker">404</span><h1>That SPOOL route does not exist.</h1><p>Use the product navigation or return to Studio.</p><div class="hero-actions"><a href="/" data-route="/" class="button secondary">Overview</a><a href="/studio" data-route="/studio" class="button primary">Open Studio</a></div></section>`, state);
}

function render() {
  if (!latestState || !appRoot) return;
  const path = currentPath();
  const pages = {
    '/': overviewPage,
    '/autopilot': autopilotPage,
    '/how-it-works': howItWorksPage,
    '/webmcp': webMcpPage,
    '/benchmarks': benchmarksPage,
    '/docs': docsPage,
    '/studio': studioDashboard,
    '/studio/new': newMigrationPage,
    '/studio/mission': missionPage,
    '/studio/results': resultsPage
  };
  appRoot.innerHTML = (pages[path] ?? (() => notFoundPage(path, latestState)))(latestState);
  document.title = `${pageTitle(path)} — SPOOL`;
}

function pageTitle(path) {
  return ({
    '/': 'Autopilot data migration', '/autopilot': 'Autopilot', '/how-it-works': 'How it works', '/webmcp': 'Temporal WebMCP',
    '/benchmarks': 'Benchmarks', '/docs': 'Docs', '/studio': 'Studio', '/studio/new': 'New migration', '/studio/mission': 'Mission', '/studio/results': 'Results'
  })[path] ?? 'SPOOL';
}

function toast(message, tone = 'neutral') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show ${tone}`;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => { el.className = 'toast'; }, 3200);
}

async function loadText(text, fileName) {
  try {
    await kernel.loadSourceText(text, fileName);
    selectedOutcome = 'database_ready';
    toast(`${fileName} is profiled locally.`, 'success');
  } catch (error) {
    toast(error?.message || String(error), 'danger');
  }
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) return toast('This UI currently limits file selection to 50 MB. Use a smaller CSV for this release.', 'danger');
  if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') return toast('SPOOL currently accepts CSV source files.', 'danger');
  await loadText(await file.text(), file.name);
}

async function runAutopilot() {
  const response = await kernel.invoke('run_autopilot', { outcome: selectedOutcome });
  if (!response.ok) return toast(`${response.error.code}: ${response.error.message}`, 'danger');
  navigate('/studio/mission');
  if (response.result?.status === 'NEEDS_ATTENTION') toast('Autopilot stopped before execution because a destructive ambiguity needs attention.', 'warning');
  else toast('Autopilot planned, dry-ran and started the migration.', 'success');
}

function download(result) {
  const blob = new Blob([result.content], { type: `${result.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = result.fileName; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleAction(action) {
  if (action === 'load-demo') return loadText(createDemoCsv(25000), 'customer-export-25k.csv');
  if (action === 'run-autopilot') return runAutopilot();
  if (action === 'reset-workspace') {
    const response = await kernel.invoke('start_new_migration', {});
    if (response.ok) { selectedOutcome = 'database_ready'; toast('Workspace cleared.', 'success'); }
    return;
  }
  if (action === 'pause-run') {
    const response = await kernel.invoke('pause_run', {});
    return response.ok ? toast(`Paused at checkpoint ${number(response.result.checkpoint)}.`, 'success') : toast(response.error.message, 'danger');
  }
  if (action === 'resume-run') {
    const response = await kernel.invoke('resume_run', {});
    return response.ok ? toast(response.result.replaying ? 'Replaying the newest revision from row zero.' : 'Resumed from the durable checkpoint.', 'success') : toast(response.error.message, 'danger');
  }
  if (action === 'abort-run') {
    const response = await kernel.invoke('abort_run', {});
    return response.ok ? toast('Mission aborted safely.', 'warning') : toast(response.error.message, 'danger');
  }
  if (action === 'export-csv' || action === 'export-json') {
    const response = await kernel.invoke(action === 'export-csv' ? 'export_csv' : 'export_json', {});
    return response.ok ? download(response.result) : toast(response.error.message, 'danger');
  }
}

function bindGlobalEvents() {
  appRoot.addEventListener('click', event => {
    const routeLink = event.target.closest('[data-route]');
    if (routeLink) { event.preventDefault(); navigate(routeLink.dataset.route); return; }
    const outcome = event.target.closest('[data-outcome]');
    if (outcome) { selectedOutcome = outcome.dataset.outcome; render(); return; }
    const action = event.target.closest('[data-action]');
    if (action && !action.disabled) void handleAction(action.dataset.action);
  });
  appRoot.addEventListener('change', event => {
    if (event.target.id === 'source-file') void loadFile(event.target.files?.[0]);
  });
  appRoot.addEventListener('dragover', event => {
    const dropzone = event.target.closest('#source-dropzone');
    if (!dropzone) return;
    event.preventDefault(); dropzone.classList.add('dragover');
  });
  appRoot.addEventListener('dragleave', event => event.target.closest('#source-dropzone')?.classList.remove('dragover'));
  appRoot.addEventListener('drop', event => {
    const dropzone = event.target.closest('#source-dropzone');
    if (!dropzone) return;
    event.preventDefault(); dropzone.classList.remove('dragover'); void loadFile(event.dataTransfer?.files?.[0]);
  });
  window.addEventListener('popstate', render);
  window.addEventListener('beforeunload', () => nativeRegistry?.dispose());
}

async function initWebMcp() {
  const result = await initializeOptionalWebMcp({ modelContext: document.modelContext, kernel });
  nativeRegistry = result.registry;
  webMcpStatus = result.status;
}

function renderBootFailure(error) {
  if (!appRoot) return;
  const message = error?.message || String(error);
  appRoot.innerHTML = `<main class="boot-failure"><div class="boot-failure-card"><span class="brand-mark">S</span><span class="kicker">STARTUP CHECK FAILED</span><h1>Unable to start SPOOL.</h1><p>The application stopped before entering the migration workflow instead of leaving you on a permanent loading screen.</p><pre>${esc(message)}</pre><div class="hero-actions"><button class="button primary" id="reload-app">Reload SPOOL</button><span>IndexedDB and Web Workers must be available in this browser.</span></div></div></main>`;
  document.getElementById('reload-app')?.addEventListener('click', () => window.location.reload());
}

async function boot() {
  if (!appRoot) throw new Error('Missing #app-root');
  bindGlobalEvents();
  await kernel.initialize();
  latestState = kernel.snapshot();
  await initWebMcp();
  render();
  window.__spoolTest = Object.freeze({
    state: () => kernel.snapshot(),
    tools: () => toolNamesForPhase(kernel.snapshot().job.phase),
    invoke: (name, args = {}) => kernel.invoke(name, args),
    navigate,
    loadDemo: () => loadText(createDemoCsv(25000), 'customer-export-25k.csv'),
    runAutopilot: outcome => kernel.invoke('run_autopilot', { outcome: outcome ?? selectedOutcome })
  });
}

try {
  await boot();
} catch (error) {
  renderBootFailure(error);
} finally {
  window.__spoolMarkBooted?.();
}
