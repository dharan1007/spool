const PRODUCT_ROUTES = new Set(['/local-runner', '/examples', '/security', '/services']);
const PRODUCT_NAV = [
  ['/local-runner', 'Local Runner'],
  ['/examples', 'Examples'],
  ['/security', 'Security'],
  ['/services', 'Services']
];
const REPO = 'https://github.com/dharan1007/spool';
const ASSESSMENT = `${REPO}/issues/new?template=migration-assessment.yml`;

function currentPath() {
  return window.location.pathname.replace(/\/+$/, '') || '/';
}

function productTopbar(path) {
  const nav = [
    ['/', 'Overview'],
    ['/local-runner', 'Local Runner'],
    ['/examples', 'Examples'],
    ['/security', 'Security'],
    ['/services', 'Services'],
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
        <span class="eyebrow-chip">GATE B · PRODUCTION-VERIFIED</span>
        <h1>The real local runner: <em>CSV → SQLite with proof.</em></h1>
        <p class="lede">The Browser Studio prepares and validates data in-browser. The Local runner is the production mutation path: it executes approved UTF-8 filesystem CSV migrations into an existing ordinary SQLite table on the customer-controlled machine.</p>
        <div class="hero-actions"><a class="button primary" href="${REPO}">Get the local runner →</a><a class="button secondary" href="/examples">Inspect the real CRM case</a></div>
      </div>
      <div class="runtime-diagram">
        <span>filesystem CSV</span><b>source snapshot</b><b>deterministic plan</b><b>target contract</b><b>target_write approval</b><b>lease + fencing</b><b>atomic rows + ledger</b><b>reconciliation</b><b>verification</b><strong>commit-bound receipt</strong>
      </div>
    </section>

    <section class="section"><div class="section-heading"><span class="kicker">WHAT ACTUALLY RUNS</span><h2>One command service, multiple local transports.</h2><p>The CLI and <code>spoold</code> do not implement separate migration engines. Both dispatch into the same production command service that owns preflight, approval, fencing, execution, reconciliation, verification and receipts.</p></div>
      <div class="surface-grid">
        <article><span>BROWSER STUDIO</span><h3>Prepare and validate CSV</h3><p>Profile, infer, transform, dry-run, execute in a Worker, checkpoint, inspect violations and export. Browser input limit: 50 MiB.</p><a href="/studio/new">Open Studio →</a></article>
        <article class="accent"><span>LOCAL RUNNER</span><h3>Mutate a real SQLite target</h3><p>Filesystem CSV → existing ordinary SQLite table, insert-only, with source/target identity binding and crash-safe evidence.</p><a href="${REPO}/blob/main/src/cli/spool.js">Inspect CLI source →</a></article>
        <article><span>LOCAL BRIDGE</span><h3><code>spoold</code></h3><p>Loopback-only authenticated HTTP bridge with bearer auth, Host/Origin checks and bounded requests. It does not expose a public hosted mutation API.</p><a href="${REPO}/blob/main/src/daemon/spoold.js">Inspect daemon source →</a></article>
      </div>
    </section>

    <section class="section"><div class="section-heading"><span class="kicker">EXECUTION CONTRACT</span><h2>Every dangerous boundary is explicit.</h2></div>
      <div class="proof-grid">
        <article><b>01</b><h3>Source snapshot</h3><p>SPOOL hashes the exact bytes it migrates. If the source changes after planning or approval, execution stops with <code>SOURCE_CHANGED</code>.</p></article>
        <article><b>02</b><h3>Live target preflight</h3><p>The target table DDL, columns, types/affinities, nullability, indexes and foreign keys become a semantic <code>targetContractId</code>. Triggered and virtual targets are rejected.</p></article>
        <article><b>03</b><h3>Bound approval</h3><p>Every production SQLite mutation requires <code>target_write</code> approval bound to the exact plan, source snapshot, target contract, effects, principal and expiry.</p></article>
        <article><b>04</b><h3>Fencing</h3><p>Durable leases issue monotonic fencing tokens. The SQLite target rechecks the token inside the write transaction so a stale runner cannot mutate after takeover.</p></article>
        <article><b>05</b><h3>Atomic evidence</h3><p>Migrated rows and SPOOL's batch reconciliation ledger commit in the same SQLite transaction. Failed writes roll back both.</p></article>
        <article><b>06</b><h3>Crash reconciliation</h3><p>If the target committed but the local checkpoint did not, restart calls reconciliation first. Exact evidence advances without replay; conflict or indeterminate state fails closed.</p></article>
        <article><b>07</b><h3>Verification</h3><p>SPOOL proves <code>source rows = written + rejected + filtered</code> and requires exact expected ledger evidence before closing the run.</p></article>
        <article><b>08</b><h3>Receipt</h3><p>The final receipt binds release commit, plan, source snapshot, target contract, batch identities, counts, violation summary and verification result.</p></article>
      </div>
    </section>

    <section class="section split-section"><div><span class="kicker">SUPPORTED TODAY</span><h2>Narrow on purpose.</h2><ul class="check-list"><li>UTF-8 filesystem CSV</li><li>Existing ordinary SQLite table</li><li><code>insert</code> write strategy</li><li>1–10,000 rows per batch</li><li>Customer-local execution</li><li>Stable pinned <code>better-sqlite3</code> runtime</li></ul></div>
      <div><span class="kicker">NOT CLAIMED</span><h2>Unsupported means unsupported.</h2><ul class="deny-list"><li>PostgreSQL</li><li>MySQL</li><li>Remote hosted database credentials</li><li>upsert / replace / delete / truncate</li><li>Triggered SQLite targets</li><li>Virtual SQLite tables</li><li>Hosted raw-row ingestion</li></ul></div>
    </section>

    <section class="section"><div class="code-workflow"><div><span class="kicker">RUN IT LOCALLY</span><h2>Install from the verified repository.</h2><p>Node.js 22+ is required. The committed lockfile pins the production SQLite dependency graph.</p></div><pre>git clone https://github.com/dharan1007/spool.git
cd spool
npm ci
npm run check
node src/cli/spool.js --help</pre></div></section>
  `);
}

function examplesPage() {
  return productShell('/examples', `
    <section class="product-hero compact-product-hero"><div><span class="eyebrow-chip">REAL CUSTOMER-STYLE FIXTURE</span><h1>The CRM case is executable evidence, not a screenshot.</h1><p class="lede"><code>examples/crm-export/</code> runs through the same production <code>SpoolCommandService</code> used by the local runner. CI checks the exact target rows, violations, ledger and receipt.</p><div class="hero-actions"><a class="button primary" href="${REPO}/tree/main/examples/crm-export">Open fixture →</a><a class="button secondary" href="${REPO}/blob/main/tests/crm-example.test.js">Read the proof test</a></div></div></section>

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
    <section class="product-hero compact-product-hero"><div><span class="eyebrow-chip">TWO TRUST BOUNDARIES</span><h1>Local-first means different controls for browser work and target mutation.</h1><p class="lede">The Browser Studio is a no-dataset-network surface. The local runner is a filesystem/database mutation surface with explicit source, target, authority and replay controls.</p></div></section>

    <section class="section"><div class="security-matrix">
      <article><span>BROWSER STUDIO</span><h2>No dataset network path</h2><ul class="check-list"><li>Production CSP contains <code>connect-src 'none'</code></li><li>No analytics transport</li><li>No WebSocket/beacon dataset path</li><li>Same-origin Worker execution</li><li>IndexedDB durable workspace</li><li>No arbitrary generated JavaScript</li></ul></article>
      <article><span>LOCAL RUNNER</span><h2>Mutation authority is bound</h2><ul class="check-list"><li>Filesystem allow-root + realpath containment</li><li>Source snapshot identity</li><li>Live target contract identity</li><li><code>target_write</code> approval</li><li>Lease + fencing token</li><li>Atomic target + ledger transaction</li><li>Reconciliation before replay</li><li>Verification before receipt</li></ul></article>
    </div></section>

    <section class="section"><div class="section-heading"><span class="kicker">FAIL-CLOSED STATES</span><h2>Uncertainty stops mutation.</h2></div><div class="failure-grid">
      <article><code>SOURCE_CHANGED</code><p>The approved bytes no longer match the source.</p></article>
      <article><code>TARGET_CONTRACT_CHANGED</code><p>The live destination schema/index/FK contract changed after approval.</p></article>
      <article><code>STALE_FENCE</code><p>An older writer lost authority after lease takeover.</p></article>
      <article><code>CONFLICT</code><p>Existing target ledger evidence disagrees with the expected batch.</p></article>
      <article><code>INDETERMINATE</code><p>SPOOL cannot prove whether a target mutation committed.</p></article>
      <article><code>STORAGE_WRITE_FAILED</code><p>Browser durable state could not be persisted; COMPLETE is not left falsely published.</p></article>
    </div></section>

    <section class="section"><div class="callout"><div><span class="kicker">SECURITY EVIDENCE</span><h2>Release checks are part of the product contract.</h2><p>Every candidate runs dependency audit, the full test suite, static network/code-execution checks, real Chrome smoke, SQLite conformance on Linux/Windows/macOS, and CodeQL.</p></div><div class="hero-actions"><a class="button secondary" href="${REPO}/blob/main/SECURITY.md">Security policy</a><a class="button secondary" href="${REPO}/blob/main/docs/THREAT_MODEL.md">Threat model</a></div></div></section>
  `);
}

function servicesPage() {
  return productShell('/services', `
    <section class="product-hero compact-product-hero"><div><span class="eyebrow-chip">SOLO BUILDER SERVICES</span><h1>Pay for a migration outcome, not a cosmetic “Pro” badge.</h1><p class="lede">Commercial migration work is offered personally by <strong>Dharan Tej Reddy Poduvu</strong>, individual solo builder/service provider. The open-source SPOOL repository remains MIT licensed.</p><div class="hero-actions"><a class="button primary" href="${ASSESSMENT}">Request a Migration Assessment →</a><a class="button secondary" href="${REPO}/blob/main/docs/MIGRATION_SERVICES.md">Service scope</a></div><p class="privacy-note">Public assessment is metadata-only. Never post production rows, customer/employee data, credentials, database dumps or private URLs.</p></div></section>

    <section class="section"><div class="service-grid">
      <article><span>01</span><h2>Migration Preflight</h2><p>Know what will fail before import: source profile, inferred schema, ambiguity/violation classes, target-readiness risks and a recommended migration scope.</p><strong>Launch test range: ₹2,500–₹7,500</strong></article>
      <article><span>02</span><h2>Import-Ready Dataset</h2><p>Receive normalized output, declared target schema, deterministic transformation evidence and explicit rejected/invalid rows.</p><strong>Launch test range: ₹5,000–₹15,000</strong></article>
      <article><span>03</span><h2>Migration Rescue</h2><p>Diagnose a failing or inconsistent import without blindly replaying uncertain writes. Start non-destructively, repair the data/contract problem, then verify the result.</p><strong>Launch test range: ₹7,500–₹25,000+</strong></article>
      <article class="accent"><span>04</span><h2>Verified CSV → SQLite Migration</h2><p>Execute the production Gate-B path locally with source snapshot, target preflight, approval, fencing, atomic ledger, reconciliation, verification and receipt.</p><strong>Launch test range: ₹10,000–₹30,000+</strong></article>
    </div></section>

    <section class="section split-section"><div><span class="kicker">HOW A PAID JOB WORKS</span><h2>No paid SaaS infrastructure required.</h2><ol class="number-list"><li>Metadata-only qualification</li><li>Private scope + quote</li><li>Customer-local execution</li><li>Output + violations + verification/receipt</li><li>Written acceptance</li></ol></div><div><span class="kicker">DATA BOUNDARY</span><h2>The website is not the customer-data plane.</h2><p>Sensitive rows do not need to be uploaded to a SPOOL-controlled backend for the current services. Payment instructions and private billing details are exchanged outside the public repository.</p><a class="text-link" href="${REPO}/blob/main/docs/DATA_HANDLING.md">Read data handling →</a></div></section>
  `);
}

function productPage(path) {
  return ({
    '/local-runner': localRunnerPage,
    '/examples': examplesPage,
    '/security': securityPage,
    '/services': servicesPage
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
  section.innerHTML = `<div class="section-heading"><span class="kicker">THE COMPLETE PRODUCT</span><h2>Two execution surfaces. One correctness model.</h2><p>Use Browser Studio when you need local CSV preparation and validation. Use the Local runner when you need a production-verified write into an existing SQLite table with approval, crash reconciliation and a receipt.</p></div><div class="surface-grid"><article><span>BROWSER STUDIO</span><h3>Work entirely in-browser</h3><p>Profile, infer, transform, validate, checkpoint, inspect violations and export without a dataset backend.</p><a href="/studio/new">Start in Studio →</a></article><article class="accent"><span>LOCAL RUNNER</span><h3>Write to a real SQLite target</h3><p>Source snapshot + live target contract + target_write approval + fencing + atomic ledger + verification + receipt.</p><a href="/local-runner">Open Local Runner →</a></article></div>`;
  finalCta.before(section);
}

function syncProductSurface() {
  const root = document.getElementById('app-root');
  if (!root) return;
  const path = currentPath();
  if (PRODUCT_ROUTES.has(path)) {
    const current = root.querySelector(`[data-product-route="${path}"]`);
    if (current) return;
    root.innerHTML = productPage(path);
    document.title = `${({ '/local-runner': 'Local Runner', '/examples': 'Examples', '/security': 'Security', '/services': 'Services' })[path]} — SPOOL`;
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
