const PRODUCT_ROUTES = new Set(['/local-runner', '/examples', '/security', '/services', '/start', '/integrations', '/developers']);
const PRODUCT_NAV = [
  ['/start', 'Start here'],
  ['/integrations', 'Integrations'],
  ['/developers', 'Developers']
];
const REPO = 'https://github.com/dharan1007/spool';

function currentPath() {
  return window.location.pathname.replace(/\/+$/, '') || '/';
}

function productTopbar(path) {
  const nav = [
    ['/', 'Overview'],
    ['/start', 'Start here'],
    ['/integrations', 'Integrations'],
    ['/developers', 'Developers'],
    ['/docs', 'Docs']
  ];
  return `<header class="topbar product-topbar">
    <a class="brand" href="/" aria-label="SPOOL overview">
      <span class="brand-mark">S</span>
      <span class="brand-word"><strong>SPOOL</strong><small>Migration correctness</small></span>
    </a>
    <nav class="primary-nav" aria-label="Primary navigation">
      ${nav.map(([href, label]) => `<a href="${href}" class="${path === href ? 'active' : ''}">${label}</a>`).join('')}
    </nav>
    <div class="top-actions">
      <span class="status-pill success"><i></i>2 execution surfaces</span>
      <a class="button secondary compact" href="/studio">Open Studio</a>
    </div>
  </header>`;
}

function productShell(path, body) {
  return `${productTopbar(path)}
    <main class="site-main product-main" data-product-route="${path}">${body}</main>
    <footer class="footer product-footer">
      <div><strong>SPOOL</strong><span>Browser-local Studio + verified customer-local CSV → SQLite runner.</span></div>
      <div><span>Browser data plane: local</span><span>Production target execution: local</span><span>Evidence: deterministic</span></div>
    </footer>`;
}

function localRunnerPage() {
  return productShell('/local-runner', `
    <section class="product-hero">
      <div>
        <span class="eyebrow-chip">RELEASED LOCAL RUNNER · VERSION 1.1.1</span>
        <h1>The real local runner: <em>CSV → SQLite with proof.</em></h1>
        <p class="lede">The Browser Studio prepares and validates data in-browser. The released Local Runner is the customer-local mutation path: bounded-memory streaming of approved UTF-8 filesystem CSV migrations into an existing ordinary SQLite table on the customer-controlled machine, with a 256 MiB default source ceiling.</p>
        <div class="hero-actions"><a class="button primary" href="${REPO}/releases/tag/v1.1.1">Install v1.1.1 →</a><a class="button secondary" href="/examples">Inspect the real CRM case</a></div>
      </div>
      <div class="runtime-diagram">
        <span>filesystem CSV</span><b>durable source snapshot</b><b>streamed plan + dry run</b><b>target contract</b><b>target_write approval</b><b>lease + fencing</b><b>bounded target batches</b><b>atomic rows + ledger</b><b>reconciliation</b><b>verification</b><strong>commit-bound receipt</strong>
      </div>
    </section>

    <section class="section"><div class="section-heading"><span class="kicker">WHAT ACTUALLY RUNS</span><h2>One command service, multiple local transports.</h2><p>The CLI and <code>spoold</code> do not implement separate migration engines. Both dispatch into the same production command service that owns snapshotting, streaming, preflight, approval, fencing, execution, reconciliation, verification and receipts.</p></div>
      <div class="surface-grid">
        <article><span>BROWSER STUDIO</span><h3>Prepare and validate CSV</h3><p>Profile, infer, transform, dry-run, execute in a Worker, checkpoint, inspect violations and export. Browser input limit: 50 MiB.</p><a href="/studio/new">Open Studio →</a></article>
        <article class="accent"><span>LOCAL RUNNER</span><h3>Mutate a real SQLite target</h3><p>Filesystem CSV → existing ordinary SQLite table, insert-only, using bounded-memory streaming, a durable customer-local snapshot and a 256 MiB default source ceiling.</p><a href="${REPO}/releases/tag/v1.1.1">Open v1.1.1 release →</a></article>
        <article><span>LOCAL BRIDGE</span><h3><code>spoold</code></h3><p>Loopback-only authenticated HTTP bridge with bearer auth, Host/Origin checks and bounded requests. It does not expose a public hosted mutation API.</p><a href="${REPO}/blob/main/src/daemon/spoold.js">Inspect daemon source →</a></article>
      </div>
    </section>

    <section class="section"><div class="section-heading"><span class="kicker">EXECUTION CONTRACT</span><h2>Every dangerous boundary is explicit.</h2></div>
      <div class="proof-grid">
        <article><b>01</b><h3>Durable source snapshot</h3><p>SPOOL copies and hashes the exact source incrementally onto customer-local disk. Changed, replaced or missing approved input stops as <code>SOURCE_CHANGED</code> before target mutation; VERIFIED completion performs snapshot cleanup.</p></article>
        <article><b>02</b><h3>Bounded-memory stream</h3><p>The Local Runner keeps parser state, bounded samples and the current target batch instead of materializing the complete CSV/output. Restart re-scans the immutable snapshot and skips to the durable batch checkpoint.</p></article>
        <article><b>03</b><h3>Live target preflight</h3><p>The target table DDL, columns, types/affinities, nullability, indexes and foreign keys become a semantic <code>targetContractId</code>. Triggered and virtual targets are rejected.</p></article>
        <article><b>04</b><h3>Bound approval</h3><p>Every production SQLite mutation requires <code>target_write</code> approval bound to the exact plan, source snapshot, target contract, effects, principal and expiry.</p></article>
        <article><b>05</b><h3>Fencing</h3><p>Durable leases issue monotonic fencing tokens. The SQLite target rechecks the token inside the write transaction so a stale runner cannot mutate after takeover.</p></article>
        <article><b>06</b><h3>Atomic evidence</h3><p>Migrated rows and SPOOL's batch reconciliation ledger commit in the same SQLite transaction. Failed writes roll back both.</p></article>
        <article><b>07</b><h3>Crash reconciliation</h3><p>If the target committed but the local checkpoint did not, restart calls reconciliation first. Exact evidence advances without replay; conflict or indeterminate state fails closed.</p></article>
        <article><b>08</b><h3>Verification + receipt</h3><p>SPOOL proves <code>source rows = written + rejected + filtered</code>, requires exact ledger evidence, then creates a receipt bound to release, plan, source, target, counts and verification.</p></article>
      </div>
    </section>

    <section class="section split-section"><div><span class="kicker">SUPPORTED TODAY</span><h2>Narrow on purpose.</h2><ul class="check-list"><li>UTF-8 filesystem CSV</li><li>Existing ordinary SQLite table</li><li><code>insert</code> write strategy</li><li>1–10,000 source rows per batch</li><li>256 MiB default Local Runner ceiling</li><li>Bounded-memory streaming + durable local snapshot</li><li>Customer-local execution</li><li>Stable pinned <code>better-sqlite3</code> runtime</li></ul></div>
      <div><span class="kicker">NOT CLAIMED</span><h2>Unsupported means unsupported.</h2><ul class="deny-list"><li>PostgreSQL</li><li>MySQL</li><li>Remote hosted database credentials</li><li>upsert / replace / delete / truncate</li><li>Triggered SQLite targets</li><li>Virtual SQLite tables</li><li>Hosted raw-row ingestion</li><li>1-GB / unlimited Local Runner input</li></ul></div>
    </section>

    <section class="section"><div class="guided-panel"><span class="kicker">BEFORE INSTALLING</span><h2>For a SQLite database operator</h2><p>First prepare the CSV and an existing compatible SQLite table. Then install SPOOL locally, create the documented migration request, inspect and dry-run it, authorize the exact plan, execute, verify and save the receipt. The published capability matrix classifies SQLite target support as experimental because sustained-load qualification is still missing; do not interpret a release download as proof of unrestricted enterprise readiness.</p><a href="/start" class="text-link">Return to the guided setup →</a></div></section>
    <section class="section"><div class="code-workflow"><div><span class="kicker">ADVANCED · INSTALL + RUN ON YOUR DEVICE</span><h2>Install the versioned CLI, then inspect, approve, run and verify.</h2><p>Node.js 22+ is required. Browser Studio stays capped at 50 MiB; for production SQLite mutation or larger CSV files use this customer-local runner. The Local Runner uses bounded-memory streaming with a 256 MiB default source ceiling. It keeps a durable content-bound snapshot on local disk for approval/recovery, re-scans that snapshot on restart, and cleans it after VERIFIED completion. Budget disk space for the snapshot plus SQLite/WAL growth. The release remains private on the npm registry; install directly from the versioned GitHub source or release artifact.</p></div><details class="developer-details"><summary>Show command-line installation and execution steps</summary><pre># Preferred v1.1.1 install — no npm-registry publication required.
npm install -g github:dharan1007/spool#v1.1.1
spool --help

# Generate a local approval-signing key.
export SPOOL_APPROVAL_KEY="$(openssl rand -hex 32)"

# Create migration.json from docs/LOCAL_RUNNER.md, then use the same roots/state file.
spool inspect --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db
spool plan --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db
spool dry-run --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db
spool approve --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db --expires 2026-12-31T23:59:59.000Z --nonce first-run --out approval.json
spool run --request migration.json --approval approval.json --source-root ./data --target-root ./data --state ./data/spool-state.db --out run-result.json
spool status --migration-id mig_customers_001 --source-root ./data --target-root ./data --state ./data/spool-state.db
spool verify --migration-id mig_customers_001 --source-root ./data --target-root ./data --state ./data/spool-state.db
spool receipt --migration-id mig_customers_001 --source-root ./data --target-root ./data --state ./data/spool-state.db --out receipt.json

# Source-verification fallback:
git clone --branch v1.1.1 https://github.com/dharan1007/spool.git
cd spool && npm ci && npm run check && npm run pack:verify</pre></details><div class="hero-actions"><a class="button primary" href="${REPO}/releases/tag/v1.1.1">Download / verify v1.1.1 →</a><a class="button secondary" href="${REPO}/blob/main/docs/LOCAL_RUNNER.md">Open migration.json guide</a><a class="button secondary" href="${REPO}/tree/main/examples/crm-export">Use the verified example</a></div></div></section>
  `);
}

function examplesPage() {
  return productShell('/examples', `
    <section class="product-hero compact-product-hero"><div><span class="eyebrow-chip">REAL CUSTOMER-STYLE FIXTURE</span><h1>The CRM case is executable evidence, not a screenshot.</h1><p class="lede"><code>examples/crm-export/</code> runs through the same production <code>SpoolCommandService</code> used by the Local Runner. CI checks the exact target rows, violations, ledger and receipt.</p><div class="hero-actions"><a class="button primary" href="${REPO}/tree/main/examples/crm-export">Open fixture →</a><a class="button secondary" href="${REPO}/blob/main/tests/crm-example.test.js">Read the proof test</a></div></div></section>

    <section class="section"><div class="example-score"><article><span>SOURCE</span><strong>5 source records</strong><p>Dirty CRM-style rows with mixed currency, dates, booleans and one invalid numeric ID.</p></article><article><span>ACCEPTED</span><strong>3 valid</strong><p>Rows that satisfy the declared SQLite target contract after deterministic transforms.</p></article><article><span>REJECTED</span><strong>2 rejected</strong><p>Invalid or ambiguous rows remain explicit; they do not silently enter the target.</p></article></div></section>

    <section class="section"><div class="section-heading"><span class="kicker">DIRTY INPUT</span><h2>The fixture deliberately includes values real imports struggle with.</h2></div><div class="proof-grid">
      <article><h3>Locale currency</h3><code>$1,299.00</code><code>1.299,00 €</code><p>Both normalize deterministically to the same numeric value when their grouping is unambiguous.</p></article>
      <article><h3>Date ambiguity</h3><code>2026-01-02</code><code>3 April 2026</code><code>04/03/2026</code><p>The numeric date is ambiguous, so SPOOL rejects it instead of guessing locale.</p></article>
      <article><h3>Boolean variants</h3><code>YES</code><code>no</code><code>true</code><code>1</code><p>Semantic booleans are normalized and stored in SQLite deterministically as 1/0.</p></article>
      <article><h3>Invalid identity</h3><code>bad numeric customer ID</code><p>Typed target validation prevents malformed identifiers from entering the destination table.</p></article>
    </div></section>

    <section class="section"><div class="callout"><div><span class="kicker">ACCEPTANCE EVIDENCE</span><h2>Rows are not the only output.</h2><p>The test asserts actual SQLite target rows, per-batch reconciliation ledger evidence, violations and the final commit-bound receipt. Exact replay is idempotent.</p></div><div class="evidence-stack"><span>target rows</span><span>violations</span><span>ledger</span><span>verification</span><strong>receipt</strong></div></div></section>
  `);
}

function securityPage() {
  return productShell('/security', `
    <section class="product-hero compact-product-hero"><div><span class="eyebrow-chip">TWO TRUST BOUNDARIES</span><h1>Local-first means different controls for browser work and target mutation.</h1><p class="lede">The Browser Studio is a no-dataset-network surface. The Local Runner is a bounded-memory filesystem/database mutation surface with explicit source, target, authority and replay controls.</p></div></section>

    <section class="section"><div class="security-matrix">
      <article><span>BROWSER STUDIO</span><h2>No dataset network path</h2><ul class="check-list"><li>Production CSP contains <code>connect-src 'none'</code></li><li>No analytics transport</li><li>No WebSocket/beacon dataset path</li><li>Same-origin Worker execution</li><li>IndexedDB durable workspace</li><li>No arbitrary generated JavaScript</li><li>50 MiB browser input boundary</li></ul></article>
      <article><span>LOCAL RUNNER</span><h2>Mutation authority is bound</h2><ul class="check-list"><li>Bounded-memory stream + 256 MiB default source ceiling</li><li>Filesystem allow-root + realpath containment</li><li>Durable customer-local source snapshot</li><li>Source revalidation + verified cleanup</li><li>Checkpoint re-scan on recovery</li><li>Live target contract identity</li><li><code>target_write</code> approval</li><li>Lease + fencing token</li><li>Atomic target + ledger transaction</li><li>Reconciliation before replay</li><li>Verification before receipt</li></ul></article>
    </div></section>

    <section class="section"><div class="section-heading"><span class="kicker">FAIL-CLOSED STATES</span><h2>Uncertainty stops mutation.</h2></div><div class="failure-grid">
      <article><code>SOURCE_CHANGED</code><p>The approved source changed, was replaced, or is no longer available.</p></article>
      <article><code>TARGET_CONTRACT_CHANGED</code><p>The live destination schema/index/FK contract changed after approval.</p></article>
      <article><code>STALE_FENCE</code><p>An older writer lost authority after lease takeover.</p></article>
      <article><code>CONFLICT</code><p>Existing target ledger evidence disagrees with the expected batch.</p></article>
      <article><code>INDETERMINATE</code><p>SPOOL cannot prove whether a target mutation committed.</p></article>
      <article><code>STORAGE_WRITE_FAILED</code><p>Browser durable state could not be persisted; COMPLETE is not left falsely published.</p></article>
    </div></section>

    <section class="section"><div class="callout"><div><span class="kicker">SECURITY EVIDENCE</span><h2>Release checks are part of the product contract.</h2><p>Every candidate runs dependency audit, the full test suite, malformed-stream/source-change/target-lock fault tests, a &gt;50 MiB Local Runner migration with V8 old-space constrained to 48 MiB, real Chrome smoke, SQLite conformance on Linux/Windows/macOS, and CodeQL.</p></div><div class="hero-actions"><a class="button secondary" href="${REPO}/blob/main/SECURITY.md">Security policy</a><a class="button secondary" href="${REPO}/blob/main/docs/THREAT_MODEL.md">Threat model</a></div></div></section>
  `);
}

function servicesPage() {
  return productShell('/services', `
    <section class="product-hero compact-product-hero"><div><span class="eyebrow-chip">DEPLOYMENT + SUPPORT</span><h1>This hosted site is the documentation and Browser Studio surface. <em>Production target writes stay local.</em></h1><p class="lede">The public deployment does not receive SQLite credentials or customer database rows. Clone SPOOL and run Gate B on the device that owns the source and target. This hosted surface is intentionally non-commercial while it is deployed on a personal Hobby workspace.</p><div class="hero-actions"><a class="button primary" href="/local-runner">Run SPOOL locally →</a><a class="button secondary" href="${REPO}">Open source repository</a></div></div></section>

    <section class="section"><div class="service-grid">
      <article><span>01</span><h2>Browser Studio</h2><p>Use the hosted UI for browser-local CSV inspection, deterministic transformation, quality review and safe export up to the documented 50 MiB Browser limit.</p></article>
      <article><span>02</span><h2>Local Runner</h2><p>Use the CLI for bounded-memory CSV → SQLite mutation up to the default 256 MiB source ceiling, with a durable local source snapshot, target preflight, bound approval, fencing, reconciliation, verification and receipt.</p></article>
      <article><span>03</span><h2>Local Bridge</h2><p>Use <code>spoold</code> when a local developer tool or agent needs authenticated loopback access to the same command service.</p></article>
      <article class="accent"><span>04</span><h2>Self-host the public surface</h2><p>Organizations that need their own hosted documentation/UI can build the static <code>dist/</code> output and deploy it under infrastructure and terms appropriate to their use.</p></article>
    </div></section>

    <section class="section split-section"><div><span class="kicker">SUPPORT</span><h2>Public issues are metadata-only.</h2><p>Report reproducible bugs and non-sensitive feature requests in GitHub. Do not attach production datasets, credentials, private URLs, database dumps, or personal/customer records to a public issue.</p><a class="text-link" href="${REPO}/issues">Open GitHub issues →</a></div><div><span class="kicker">SELF-HOSTING</span><h2>Keep production control with the operator.</h2><p>The repository documents the release build, exact-SHA provenance, static hosting model, and local mutation boundary. The hosted UI is not a remote database execution service.</p><a class="text-link" href="${REPO}/blob/main/docs/SELF_HOSTING.md">Read self-hosting guide →</a></div></section>
  `);
}

function startPage(){return productShell('/start', `
  <section class="product-hero compact-product-hero"><div><span class="eyebrow-chip">START HERE · NO CODE REQUIRED FOR BROWSER STUDIO</span><h1>What do you need to <em>move or prepare?</em></h1><p class="lede">Choose the outcome first. SPOOL will show the correct interface, what runs on your device, and the evidence you will receive. You do not need to understand API responses to choose a path.</p></div></section>
  <section class="section"><div class="start-paths" aria-label="Choose a SPOOL workflow">
    <article><span>01 · NO INSTALL</span><h2>Clean a spreadsheet export</h2><p>You have a CSV, and want a validated CSV or JSON output. Add the file in your browser, choose a cleanup outcome, run Autopilot, review rejected rows and export. Nothing is sent to a SPOOL data server.</p><p class="path-limit">Input: CSV up to 50 MiB · Result: browser-local output, not a live database write.</p><a href="/studio/new" class="button primary">Open the CSV Studio →</a></article>
    <article><span>02 · LOCAL INSTALL</span><h2>Write CSV into SQLite</h2><p>You have a CSV and an existing SQLite database. Install the released local runner on the computer holding the data. An operator reviews source and destination, runs a dry-run, approves the exact operation, executes it and examines the receipt.</p><p class="path-limit">Default CSV ceiling: 256 MiB · Insert-only, ordinary SQLite targets · Command line and setup required.</p><a href="/local-runner" class="button secondary">See the local setup →</a></article>
    <article><span>03 · DEVELOPER INTEGRATION</span><h2>Connect an existing application</h2><p>Your application can invoke SPOOL through its local CLI or an authenticated loopback bridge. A developer installs and runs the command service on the customer-controlled machine. This website does not host a remote migration API.</p><p class="path-limit">Execution stays local · Approvals are not bypassed · Requires development work.</p><a href="/integrations" class="button secondary">Explore integration paths →</a></article>
  </div></section>
  <section class="section"><div class="guided-panel"><span class="kicker">NOT YET A RELEASED CONNECTOR</span><h2>Need PostgreSQL, MySQL, an enterprise agent or hosted automation?</h2><p>Those are not part of the currently published v1.1.1 PostgreSQL production scope. Do not put production credentials into Browser Studio or assume an experimental connector is qualified.</p><a href="/docs" class="text-link">Read capability and limit explanations →</a></div></section>
`);}

function integrationPage(){return productShell('/integrations', `
  <section class="product-hero compact-product-hero"><div><span class="eyebrow-chip">INTEGRATIONS · CHOOSE A TRANSPORT</span><h1>Connect SPOOL without <em>guessing where the API lives.</em></h1><p class="lede">An integration is software running on your device, not a button that uploads your database to this site. Pick the supported execution surface before writing any code.</p><div class="hero-actions"><a class="button primary" href="/start">Choose a workflow →</a><a class="button secondary" href="/developers">Developer reference →</a></div></div></section>
  <section class="section"><div class="start-paths">
    <article><span>NO-CODE BROWSER FLOW</span><h2>Prepare data</h2><p>Open Studio, choose your CSV and an outcome, inspect validation, and download the result. No API key, server or integration snippet is necessary.</p><a class="text-link" href="/studio/new">Open Studio →</a></article>
    <article><span>CLI AUTOMATION</span><h2>Run an approved SQLite migration</h2><p>Install v1.1.1 on the machine holding your existing SQLite table and CSV. A developer can invoke the CLI within local automation, preserving the inspect → plan → dry-run → approve → run → verify → receipt sequence.</p><a class="text-link" href="/local-runner">Local runner instructions →</a></article>
    <article><span>LOCAL HTTP BRIDGE</span><h2>Integrate a local app or agent</h2><p>The source includes an authenticated loopback command service. It is not a hosted API and is not started merely by opening this website. Configure it with a local command service, a strong bearer token and an approved Origin policy.</p><a class="text-link" href="/developers">Bridge contract and setup →</a></article>
  </div></section>
  <section class="section"><div class="guided-panel"><span class="kicker">IMPORTANT BOUNDARY</span><h2>Why a raw API response is not an onboarding screen</h2><p>Machine-readable command responses belong in developer tools; an HTTP endpoint does not provide a human UI. For humans, use Studio or these guides. For applications, use the local CLI or the loopback bridge after provisioning the customer-controlled runtime. This hosted website has no public database-write API, no cloud database connection form and no universal integration token.</p></div></section>
`);}

function developerPage(){return productShell('/developers', `
  <section class="product-hero compact-product-hero"><div><span class="eyebrow-chip">DEVELOPER REFERENCE · LOCAL ONLY</span><h1>The correct integration <em>boundary and sequence.</em></h1><p class="lede">Start with the released CLI for production-scoped filesystem CSV to SQLite operations. The loopback HTTP bridge is an integration component, not a remotely hosted SPOOL API. Code examples and machine formats are deliberately kept in the technical section below.</p><div class="hero-actions"><a href="/integrations" class="button primary">Choose an integration →</a><a href="/local-runner" class="button secondary">Released runner setup →</a></div></div></section>
  <section class="section"><div class="step-flow"><article class="step-card"><span>01</span><h3>Provision locally</h3><p>Install the exact released version on the same customer-controlled system as the source and target. Use a separately configured local bridge only when a client requires HTTP.</p></article><article class="step-card"><span>02</span><h3>Inspect before writing</h3><p>Inspect source and live target, create a plan, then run a dry-run. Stop on source or contract drift.</p></article><article class="step-card"><span>03</span><h3>Authorize explicitly</h3><p>Issue the supported bound approval for the exact operation. An API invocation is not itself permission to mutate.</p></article><article class="step-card"><span>04</span><h3>Execute and check</h3><p>Run only the approved operation, reconcile ambiguous results, verify the supported evidence and retrieve the receipt.</p></article></div></section>
  <section class="section"><div class="guided-panel"><span class="kicker">LOCAL API FACTS</span><h2>What the bridge actually exposes</h2><p>The current source exports a loopback-only daemon factory. A developer must initialize the local command service, supply a strong bearer token, configure allowed Origins and start the server. It accepts authenticated POST requests to <code>/v1/command</code> on its chosen localhost port; a direct browser navigation or GET is not a valid command call. The daemon returns JSON for programmatic consumers, not a rendered migration dashboard.</p><p>Do not point production tools at this site's <code>/api</code> path or treat a JSON document as an installation wizard. The published CLI is the release-scoped local execution path.</p><details class="developer-details"><summary>Show technical transport contract</summary><div class="developer-detail-inner"><p><strong>Method:</strong> POST. <strong>Host:</strong> customer-controlled loopback IP. <strong>Path:</strong> /v1/command. <strong>Authorization:</strong> Bearer token, at least 32 bytes. <strong>Body:</strong> bounded JSON command envelope. <strong>Response:</strong> structured success or error JSON.</p><p>Supported source commands include inspect, plan, dry-run, approve, run, status, verify and receipt; check the exact released adapter before relying on additional commands. The website itself cannot connect to this bridge because its browser Content Security Policy disallows outbound requests.</p><p><a class="text-link" href="${REPO}/blob/main/src/daemon/spoold.js">Review the actual daemon contract →</a> <a class="text-link" href="${REPO}/blob/main/docs/LOCAL_RUNNER.md">See installation and approval instructions →</a></p></div></details></div></section>
`);}

function productPage(path) {
  return ({
    '/local-runner': localRunnerPage,
    '/examples': examplesPage,
    '/security': securityPage,
    '/services': servicesPage,
    '/start': startPage,
    '/integrations': integrationPage,
    '/developers': developerPage
  })[path]?.();
}

function addProductNav(root, path) {
  const nav = root.querySelector('.primary-nav');
  if (!nav) return;
  for (const [href, label] of PRODUCT_NAV) {
    if (nav.querySelector(`a[href="${href}"]`)) continue;
    const link = document.createElement('a');
    link.href = href;
    link.textContent = label;
    if (path === href) link.className = 'active';
    nav.append(link);
  }
  const sub = root.querySelector('.brand-word small');
  if (sub) sub.textContent = 'Migration correctness';
}

function addHomepageProductBand(root) {
  if (currentPath() !== '/' || root.querySelector('#complete-product')) return;
  const finalCta = root.querySelector('.final-cta');
  if (!finalCta) return;
  const section = document.createElement('section');
  section.id = 'complete-product';
  section.className = 'section complete-product-band';
  section.innerHTML = `<div class="section-heading"><span class="kicker">THE COMPLETE PRODUCT</span><h2>Two execution surfaces. One correctness model.</h2><p>Use Browser Studio when you need local CSV preparation and validation. Use the Local Runner when you need a production-verified, bounded-memory write into an existing SQLite table with a durable snapshot, approval, crash reconciliation and a receipt.</p></div><div class="surface-grid"><article><span>BROWSER STUDIO</span><h3>Work entirely in-browser</h3><p>Profile, infer, transform, validate, checkpoint, inspect violations and export without a dataset backend. Browser input limit: 50 MiB.</p><a href="/studio/new">Start in Studio →</a></article><article class="accent"><span>LOCAL RUNNER</span><h3>Write to a real SQLite target</h3><p>Bounded-memory stream + 256 MiB default source ceiling + durable snapshot + live target contract + target_write approval + fencing + atomic ledger + verification + receipt.</p><a href="/local-runner">Open Local Runner →</a></article></div>`;
  finalCta.before(section);
  const hero = root.querySelector('.hero');
  if (hero && !root.querySelector('#choose-path')) {
    const chooser = document.createElement('section');
    chooser.id = 'choose-path';
    chooser.className = 'section guided-home-band';
    chooser.innerHTML = '<div><span class="kicker">START WITH YOUR GOAL</span><h2>No API setup required to begin.</h2><p>Clean a CSV in the browser, prepare a local SQLite migration, or connect an existing app. The supported boundary is different for each path.</p></div><a class="button primary" href="/start">Choose your setup →</a>';
    hero.after(chooser);
  }
}

function syncProductSurface() {
  const root = document.getElementById('app-root');
  if (!root) return;
  const path = currentPath();
  if (PRODUCT_ROUTES.has(path)) {
    const current = root.querySelector(`[data-product-route="${path}"]`);
    if (current) return;
    root.innerHTML = productPage(path);
    document.title = `${({ '/local-runner': 'Local Runner', '/examples': 'Examples', '/security': 'Security', '/services': 'Services', '/start': 'Start here', '/integrations': 'Integrations', '/developers': 'Developers' })[path]} — SPOOL`;
    return;
  }
  addProductNav(root, path);
  addHomepageProductBand(root);
}

const appRoot = document.getElementById('app-root');
if (appRoot) {
  const observer = new MutationObserver(() => queueMicrotask(syncProductSurface));
  observer.observe(appRoot, { childList: true });
}
window.addEventListener('popstate', () => queueMicrotask(syncProductSurface));
queueMicrotask(syncProductSurface);
