const REPO = 'https://github.com/dharan1007/spool';
const RELEASE = 'v1.1.1';

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>'"]/g, function (char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char];
  });
}

function route(href, label, cls) {
  return "<a href='" + href + "' data-site-route='" + href + "' class='" + (cls || '') + "'>" + label + "</a>";
}

function external(href, label, cls) {
  return "<a href='" + href + "' class='" + (cls || '') + "'>" + label + "</a>";
}

function badge(text) {
  return "<span class='redesign-eyebrow'>" + esc(text) + "</span>";
}

function buttonRow(items) {
  return "<div class='redesign-actions'>" + items.join('') + "</div>";
}

function workflowStrip() {
  var steps = [
    ['01', 'Original file', 'Load CSV/XLSX'],
    ['02', 'Inspect', 'See raw rows'],
    ['03', 'Understand', 'Find formats & problems'],
    ['04', 'Transform', 'Approve field rules'],
    ['05', 'Test', 'Dry-run without changes'],
    ['06', 'Process', 'Apply the approved plan'],
    ['07', 'Validate', 'Check and export']
  ];
  return "<div class='redesign-workflow'>" + steps.map(function (step) {
    return "<article><span>" + step[0] + "</span><div><strong>" + step[1] + "</strong><small>" + step[2] + "</small></div></article>";
  }).join('') + "</div>";
}

function home(ctx) {
  var resume = ctx.resumePath;
  return [
    "<section class='redesign-hero'>",
      "<div class='redesign-hero-copy'>",
        badge('Browser-local preparation + verified local execution'),
        "<h1>Move messy data through a clear, controlled workflow.</h1>",
        "<p>SPOOL separates every important decision: inspect the source, understand problems, approve the transformation, test it without committing, process the records, then validate the result. No mystery button and no hidden jump from upload to execution.</p>",
        buttonRow([
          route(resume, ctx.hasSource ? 'Resume current workflow →' : 'Start with a file →', 'redesign-button primary large'),
          route('/how-it-works', 'See every stage', 'redesign-button secondary large')
        ]),
        "<div class='redesign-trust'><span>CSV + XLSX</span><span>50 MiB Browser Studio limit</span><span>Rows stay local</span></div>",
      "</div>",
      "<aside class='redesign-decision'>",
        "<span class='redesign-label'>CHOOSE WHAT YOU NEED</span>",
        route(resume, "<span class='redesign-choice-number'>01</span><div><strong>Prepare a dataset</strong><p>Inspect, transform, dry-run, process and export CSV/XLSX in Browser Studio.</p></div><b>Open Studio →</b>", 'redesign-choice primary-choice'),
        route('/local-runner', "<span class='redesign-choice-number'>02</span><div><strong>Write to SQLite</strong><p>Use the verified Local Runner for customer-controlled production target mutation.</p></div><b>Open Local Runner →</b>", 'redesign-choice'),
      "</aside>",
    "</section>",
    "<section class='redesign-section'>",
      "<div class='redesign-section-head'><div>", badge('THE BROWSER WORKFLOW'), "<h2>Seven pages. Seven jobs.</h2><p>Each page answers one question and ends with a clear next action. Processing cannot begin until the transformation has been explicitly tested.</p></div>",
      route('/studio/original', 'Open step 1 →', 'redesign-button secondary'), "</div>",
      workflowStrip(),
    "</section>",
    "<section class='redesign-section redesign-two-col'>",
      "<article class='redesign-feature dark'><span>BROWSER STUDIO</span><h2>Prepare and validate before anything is committed.</h2><p>Use the website when you need to understand and transform a file. It supports CSV and XLSX, preserves explicit rejection evidence, and keeps the dataset inside the browser.</p>",
      buttonRow([route('/studio/original', 'Start Browser Studio', 'redesign-button light'), route('/examples', 'View example evidence', 'redesign-button text')]), "</article>",
      "<article class='redesign-feature'><span>LOCAL RUNNER</span><h2>Use a separate production path when the destination is SQLite.</h2><p>The CLI owns source snapshotting, target preflight, approval, fencing, reconciliation, verification and receipts. The hosted site does not receive customer database credentials.</p>",
      buttonRow([route('/local-runner', 'See Local Runner', 'redesign-button secondary'), route('/security', 'Review safety boundaries', 'redesign-button text')]), "</article>",
    "</section>",
    "<section class='redesign-section redesign-callout'><div>", badge('NO DEAD ENDS'), "<h2>Every blocked state must tell you what happened and what you can do next.</h2><p>Invalid source → replace it. Ambiguous transformation → review the mapping. Failed dry test → inspect violations and revise. Paused processing → resume. Completed processing → validate and export.</p></div>",
      route('/how-it-works', 'See state-by-state actions →', 'redesign-button secondary'), "</section>"
  ].join('');
}

function howItWorks() {
  var stages = [
    ['01', 'Original file', 'Load a CSV or XLSX. SPOOL fingerprints the parsed source before moving forward.', 'Continue to Inspect'],
    ['02', 'Inspect the data', 'Review raw rows, row/column counts and the parser’s observed schema.', 'Continue to Understand'],
    ['03', 'Understand columns', 'See likely formats, nulls, whitespace, cardinality and sampled problem values.', 'Prepare transformation'],
    ['04', 'Prepare transformation', 'Review every input → output field, type, transform, null policy and confidence before approval.', 'Approve transformation'],
    ['05', 'Test without changes', 'Run the real transform and typed validator on a bounded sample without creating durable output.', 'Approve test & continue'],
    ['06', 'Process the data', 'Apply only the approved mapping. Pause/resume controls stay visible while the Worker runs.', 'Validate final results'],
    ['07', 'Validate results', 'Confirm final counts, violations, output schema and actual transformed rows before export.', 'Export CSV / JSON']
  ];
  return [
    "<section class='redesign-page-hero'><div>", badge('HOW IT WORKS'), "<h1>The interface follows the actual data lifecycle.</h1><p>There is no separate magic workflow hidden behind the UI. Each mutating boundary is visible and the same command kernel backs the explicit stages.</p>",
      buttonRow([route('/studio/original', 'Start at step 1 →', 'redesign-button primary large'), route('/docs', 'Read implementation notes', 'redesign-button secondary large')]), "</div></section>",
    "<section class='redesign-section redesign-stage-list'>",
      stages.map(function (stage) {
        return "<article><span class='redesign-stage-number'>" + stage[0] + "</span><div><h2>" + stage[1] + "</h2><p>" + stage[2] + "</p></div><strong>" + stage[3] + "</strong></article>";
      }).join(''),
    "</section>",
    "<section class='redesign-section redesign-three-col'>",
      "<article><span>READ-ONLY</span><h3>Inspect and dry-run</h3><p>Source inspection and step 5 do not create durable transformed output.</p></article>",
      "<article><span>COMMIT BOUNDARY</span><h3>Processing starts in step 6</h3><p>The full dataset is only applied after the mapping and dry test have been accepted.</p></article>",
      "<article><span>FINAL PROOF</span><h3>Validation closes the loop</h3><p>Final counts and explicit rejection groups are shown with the output revision before export.</p></article>",
    "</section>"
  ].join('');
}

function docs() {
  return [
    "<section class='redesign-page-hero'><div>", badge('QUICK START'), "<h1>Start with the surface that matches the job.</h1><p>Browser Studio is for preparing and validating CSV/XLSX. Local Runner is for production CSV → SQLite mutation on the machine that owns the data.</p></div></section>",
    "<section class='redesign-section redesign-docs-grid'>",
      "<article><span>BROWSER STUDIO</span><h2>Prepare a file</h2><ol><li>Open Original file.</li><li>Load CSV or XLSX.</li><li>Inspect raw rows.</li><li>Review field understanding.</li><li>Approve the proposed transformation.</li><li>Run a non-committing test.</li><li>Process, validate and export.</li></ol>",
      route('/studio/original', 'Open Browser Studio →', 'redesign-button primary'), "</article>",
      "<article><span>LOCAL RUNNER</span><h2>Write to SQLite</h2><ol><li>Install the pinned release.</li><li>Inspect source and target.</li><li>Create the plan.</li><li>Dry-run it.</li><li>Issue target_write approval.</li><li>Run with checkpoints and fencing.</li><li>Verify and emit a receipt.</li></ol>",
      route('/local-runner', 'Open Local Runner docs →', 'redesign-button secondary'), "</article>",
      "<article><span>TROUBLESHOOTING</span><h2>If a stage is blocked</h2><ul><li>Source rejected: replace the file.</li><li>Mapping blocked: fix ambiguity before approval.</li><li>Dry test failed: inspect violations and revise.</li><li>Processing paused: resume from checkpoint.</li><li>Processing failed: start a new migration only after reviewing the error.</li></ul>",
      route('/how-it-works', 'Review stage behavior →', 'redesign-button text'), "</article>",
    "</section>"
  ].join('');
}

function webmcp(ctx) {
  var tools = ctx.tools || [];
  return [
    "<section class='redesign-page-hero'><div>", badge('WEBMCP'), "<h1>Agent capabilities follow the same workflow state.</h1><p>SPOOL only exposes commands that are valid for the current durable phase. WebMCP is an integration surface, not a replacement for the visible seven-stage workflow.</p></div></section>",
    "<section class='redesign-section'><div class='redesign-section-head'><div><h2>Available now</h2><p>Current phase: <code>" + esc(ctx.phase) + "</code></p></div><span class='redesign-metric-chip'>" + tools.length + " tools</span></div>",
      "<div class='redesign-tool-grid'>", tools.length ? tools.map(function (name) { return "<article><span>AVAILABLE</span><code>" + esc(name) + "</code></article>"; }).join('') : "<div class='redesign-empty'>No phase-specific tools are registered yet.</div>", "</div></section>",
    "<section class='redesign-section redesign-callout'><div><h2>Human workflow first.</h2><p>The website should remain understandable even when no agent integration is present.</p></div>", route(ctx.resumePath, 'Open Studio →', 'redesign-button primary'), "</section>"
  ].join('');
}

function benchmarks() {
  return [
    "<section class='redesign-page-hero'><div>", badge('VERIFICATION'), "<h1>Performance claims belong next to their test boundary.</h1><p>Browser preparation and production target mutation are separate execution surfaces. Correctness remains the primary invariant.</p></div></section>",
    "<section class='redesign-section redesign-three-col'>",
      "<article><span>BROWSER</span><h3>Parsing + transformation</h3><p>Measure parsing, profiling, dry-run latency and Worker processing under the 50 MiB Browser Studio boundary.</p></article>",
      "<article><span>LOCAL RUNNER</span><h3>Bounded-memory mutation</h3><p>Verify streaming, checkpoint recovery, SQLite transaction behavior and target reconciliation under the 256 MiB default source ceiling.</p></article>",
      "<article><span>CORRECTNESS</span><h3>Counts and receipts</h3><p>Processed rows must reconcile to accepted and explicitly rejected outcomes regardless of throughput.</p></article>",
    "</section>",
    "<section class='redesign-section redesign-callout'><div><h2>Inspect executable evidence.</h2><p>The CRM fixture shows accepted rows, rejected rows, ledger evidence and the final receipt.</p></div>", route('/examples', 'Open the example →', 'redesign-button secondary'), "</section>"
  ].join('');
}

function localRunner() {
  return [
    "<section class='redesign-page-hero redesign-product-hero'><div>", badge('LOCAL RUNNER · EXPERIMENTAL TARGET WRITES'), "<h1>CSV → SQLite with explicit approval, recovery and proof.</h1><p>The Browser Studio prepares files. The candidate Local Runner defaults to denying target execution until independent qualification passes. Marked disposable engineering runs exercise existing ordinary SQLite tables with bounded-memory streaming and a 256 MiB default source ceiling.</p>",
      buttonRow([external(REPO + '/releases/tag/' + RELEASE, 'Open ' + RELEASE + ' release →', 'redesign-button primary large'), route('/examples', 'See the verified CRM example', 'redesign-button secondary large')]), "</div>",
      "<aside class='redesign-runner-sequence'><span>1 · Snapshot source</span><span>2 · Inspect target</span><span>3 · Plan</span><span>4 · Dry-run</span><span>5 · target_write approval</span><span>6 · Execute with fencing</span><span>7 · Reconcile</span><strong>8 · Verify + receipt</strong></aside>",
    "</section>",
    "<section class='redesign-section'><div class='redesign-section-head'><div>", badge('WHAT TO USE'), "<h2>Choose the execution surface by destination.</h2><p>Do not use the hosted Browser Studio as if it were a remote database service.</p></div></div>",
      "<div class='redesign-choice-grid'>",
        "<article><span>BROWSER STUDIO</span><h3>Prepare CSV / XLSX</h3><p>Inspect, understand, transform, dry-run, process in a Worker, validate and export. Browser limit: 50 MiB.</p>", route('/studio/original', 'Open Browser Studio →', 'redesign-button secondary'), "</article>",
        "<article class='featured'><span>LOCAL RUNNER</span><h3>Write to SQLite</h3><p>Filesystem CSV → existing ordinary SQLite table, insert-only, with durable snapshot, target contract, approval, fencing and reconciliation.</p>", external(REPO + '/releases/tag/' + RELEASE, 'Install Local Runner →', 'redesign-button primary'), "</article>",
        "<article><span>LOCAL BRIDGE</span><h3>Use spoold for local tools</h3><p>Loopback-only authenticated HTTP access to the same command service. It is not a public hosted mutation API.</p>", external(REPO + '/blob/main/src/daemon/spoold.js', 'Inspect spoold →', 'redesign-button text'), "</article>",
      "</div>",
    "</section>",
    "<section class='redesign-section'><div class='redesign-section-head'><div>", badge('EXECUTION CONTRACT'), "<h2>Every dangerous boundary is explicit.</h2></div></div>",
      "<div class='redesign-proof-grid'>",
        "<article><b>01</b><h3>Durable source snapshot</h3><p>Changed, missing or replaced approved input stops before target mutation.</p></article>",
        "<article><b>02</b><h3>Bounded-memory stream</h3><p>Recovery re-scans the immutable snapshot and skips to the durable checkpoint.</p></article>",
        "<article><b>03</b><h3>Live target preflight</h3><p>DDL, columns, type affinity, nullability, indexes and foreign keys become the target contract.</p></article>",
        "<article><b>04</b><h3>Bound approval</h3><p><code>target_write</code> approval binds the exact plan, source snapshot, target contract, principal and expiry.</p></article>",
        "<article><b>05</b><h3>Fencing</h3><p>Monotonic fencing tokens prevent an old runner from mutating after takeover.</p></article>",
        "<article><b>06</b><h3>Atomic evidence</h3><p>Target rows and the reconciliation ledger commit in the same SQLite transaction.</p></article>",
        "<article><b>07</b><h3>Crash reconciliation</h3><p>Restart checks target evidence before replaying; conflict or indeterminate state fails closed.</p></article>",
        "<article><b>08</b><h3>Verification + receipt</h3><p>Counts reconcile before a commit-bound receipt is emitted.</p></article>",
      "</div>",
    "</section>",
    "<section class='redesign-section redesign-support-grid'>",
      "<article><span>SUPPORTED TODAY</span><h2>Deliberately narrow.</h2><ul class='redesign-check'><li>UTF-8 filesystem CSV</li><li>Existing ordinary SQLite table</li><li><code>insert</code> strategy</li><li>1–10,000 source rows per batch</li><li>256 MiB default source ceiling</li><li>Customer-local execution</li></ul></article>",
      "<article><span>NOT CLAIMED</span><h2>Unsupported means unsupported.</h2><ul class='redesign-deny'><li>PostgreSQL</li><li>MySQL</li><li>Remote hosted database credentials</li><li>upsert / replace / delete / truncate</li><li>Triggered or virtual SQLite targets</li><li>Hosted raw-row ingestion</li></ul></article>",
    "</section>",
    "<section class='redesign-section redesign-command-card'><div><span class='redesign-eyebrow'>INSTALL + RUN</span><h2>The production path is a deliberate sequence.</h2><p>Node.js 22+ is required. Browser Studio stays capped at 50 MiB. Use the same roots and durable state file across the full Local Runner lifecycle.</p></div>",
      "<pre>npm install -g github:dharan1007/spool#v1.1.1\nspool --help\nexport SPOOL_APPROVAL_KEY=&quot;$(openssl rand -hex 32)&quot;\nspool inspect --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db\nspool plan --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db\nspool dry-run --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db\nspool approve --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db --expires 2026-12-31T23:59:59.000Z --nonce first-run --out approval.json\nspool run --request migration.json --approval approval.json --source-root ./data --target-root ./data --state ./data/spool-state.db --out run-result.json\nspool status --migration-id mig_customers_001 --source-root ./data --target-root ./data --state ./data/spool-state.db\nspool verify --migration-id mig_customers_001 --source-root ./data --target-root ./data --state ./data/spool-state.db\nspool receipt --migration-id mig_customers_001 --source-root ./data --target-root ./data --state ./data/spool-state.db --out receipt.json</pre>",
      buttonRow([external(REPO + '/releases/tag/' + RELEASE, 'Download / verify ' + RELEASE + ' →', 'redesign-button primary'), external(REPO + '/blob/main/docs/LOCAL_RUNNER.md', 'Open migration.json guide', 'redesign-button secondary'), external(REPO + '/tree/main/examples/crm-export', 'Use verified example', 'redesign-button text')]),
    "</section>"
  ].join('');
}

function examples() {
  return [
    "<section class='redesign-page-hero'><div>", badge('EXECUTABLE EXAMPLE'), "<h1>The CRM fixture shows what SPOOL accepts, rejects and proves.</h1><p><code>examples/crm-export/</code> runs through the same production command service used by Local Runner.</p>",
      buttonRow([external(REPO + '/tree/main/examples/crm-export', 'Open fixture →', 'redesign-button primary large'), external(REPO + '/blob/main/tests/crm-example.test.js', 'Read proof test', 'redesign-button secondary large')]), "</div></section>",
    "<section class='redesign-section redesign-result-score'><article><span>SOURCE</span><strong>5 source records</strong><p>Mixed currency, dates, booleans and one invalid numeric identity.</p></article><article><span>ACCEPTED</span><strong>3 valid</strong><p>Rows satisfying the deterministic target contract.</p></article><article><span>REJECTED</span><strong>2 rejected</strong><p>Invalid or ambiguous records remain explicit.</p></article></section>",
    "<section class='redesign-section redesign-proof-grid'><article><h3>Locale currency</h3><code>$1,299.00</code><code>1.299,00 €</code><p>Unambiguous grouping can normalize deterministically.</p></article><article><h3>Date ambiguity</h3><code>04/03/2026</code><p>An ambiguous numeric date is rejected instead of guessed.</p></article><article><h3>Boolean variants</h3><code>YES · no · true · 1</code><p>Known semantic booleans normalize deterministically.</p></article><article><h3>Invalid identity</h3><code>bad numeric customer ID</code><p>Typed target validation blocks malformed identifiers.</p></article></section>",
    "<section class='redesign-section redesign-callout'><div><h2>Evidence includes more than output rows.</h2><p>The case asserts target rows, violations, reconciliation ledger evidence, verification and the final receipt.</p></div>", route('/local-runner', 'See the full execution contract →', 'redesign-button secondary'), "</section>"
  ].join('');
}

function security() {
  return [
    "<section class='redesign-page-hero'><div>", badge('SECURITY BOUNDARIES'), "<h1>Browser preparation and database mutation have different trust models.</h1><p>The hosted Browser Studio has no dataset network path. The Local Runner is customer-local and binds source, target and mutation authority before execution.</p></div></section>",
    "<section class='redesign-section redesign-security-grid'>",
      "<article><span>BROWSER STUDIO</span><h2>No dataset network path</h2><ul class='redesign-check'><li><code>connect-src 'none'</code></li><li>No analytics transport</li><li>Same-origin Worker execution</li><li>IndexedDB durable workspace</li><li>No arbitrary generated JavaScript</li><li>50 MiB browser input boundary</li></ul>", route('/studio/original', 'Open Studio →', 'redesign-button secondary'), "</article>",
      "<article><span>LOCAL RUNNER</span><h2>Mutation authority is explicit</h2><ul class='redesign-check'><li>Bounded-memory stream</li><li>Filesystem allow-root + realpath containment</li><li>Durable source snapshot</li><li>Live target contract</li><li><code>target_write</code> approval</li><li>Lease + fencing</li><li>Atomic target + ledger transaction</li><li>Reconciliation before replay</li><li>Verification before receipt</li></ul>", route('/local-runner', 'Review Local Runner →', 'redesign-button secondary'), "</article>",
    "</section>",
    "<section class='redesign-section'><div class='redesign-section-head'><div>", badge('FAIL-CLOSED STATES'), "<h2>Uncertainty stops mutation.</h2></div></div><div class='redesign-failure-grid'><article><code>SOURCE_CHANGED</code><p>Approved input changed or disappeared.</p></article><article><code>TARGET_CONTRACT_CHANGED</code><p>The live target no longer matches approval.</p></article><article><code>STALE_FENCE</code><p>An older writer lost authority.</p></article><article><code>CONFLICT</code><p>Existing ledger evidence disagrees.</p></article><article><code>INDETERMINATE</code><p>Commit state cannot be proven.</p></article><article><code>STORAGE_WRITE_FAILED</code><p>Durable state could not be persisted safely.</p></article></div></section>"
  ].join('');
}

function services() {
  return [
    "<section class='redesign-page-hero'><div>", badge('DEPLOYMENT + SUPPORT'), "<h1>The hosted site prepares data. Production target writes stay local.</h1><p>The public deployment does not receive SQLite credentials or customer database rows. This hosted surface is intentionally non-commercial while deployed on a personal Hobby workspace.</p>",
      buttonRow([route('/local-runner', 'Run SPOOL locally →', 'redesign-button primary large'), external(REPO, 'Open source repository', 'redesign-button secondary large')]), "</div></section>",
    "<section class='redesign-section redesign-service-grid'><article><span>01</span><h2>Browser Studio</h2><p>Hosted browser-local CSV/XLSX inspection, transformation, dry-run, processing and export.</p>", route('/studio/original', 'Open Studio →', 'redesign-button secondary'), "</article><article><span>02</span><h2>Local Runner</h2><p>Customer-local CSV → SQLite with snapshot, approval, fencing, reconciliation, verification and receipt.</p>", route('/local-runner', 'Open Local Runner →', 'redesign-button secondary'), "</article><article><span>03</span><h2>Local Bridge</h2><p><code>spoold</code> gives local developer tools authenticated loopback access to the command service.</p>", external(REPO + '/blob/main/src/daemon/spoold.js', 'Inspect spoold →', 'redesign-button text'), "</article><article><span>04</span><h2>Self-host</h2><p>Build the static <code>dist/</code> output and deploy it under infrastructure appropriate to your organization.</p>", external(REPO + '/blob/main/docs/SELF_HOSTING.md', 'Read self-hosting guide →', 'redesign-button text'), "</article></section>",
    "<section class='redesign-section redesign-callout'><div><h2>Support is metadata-only.</h2><p>Do not attach production datasets, credentials, private URLs, database dumps or customer records to public issues.</p></div>", external(REPO + '/issues', 'Open GitHub issues →', 'redesign-button secondary'), "</section>"
  ].join('');
}

export function renderSitePage(path, ctx) {
  var pages = {
    '/': home,
    '/how-it-works': howItWorks,
    '/webmcp': webmcp,
    '/benchmarks': benchmarks,
    '/docs': docs,
    '/local-runner': localRunner,
    '/examples': examples,
    '/security': security,
    '/services': services
  };
  var page = pages[path];
  return page ? page(ctx || {}) : '';
}

export const SITE_PATHS = Object.freeze([
  '/', '/how-it-works', '/webmcp', '/benchmarks', '/docs',
  '/local-runner', '/examples', '/security', '/services'
]);
