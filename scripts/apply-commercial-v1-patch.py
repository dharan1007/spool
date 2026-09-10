from pathlib import Path

p = Path('src/product-surface.js')
s = p.read_text()
old = '<div class="hero-actions"><a class="button primary" href="${REPO}">Get the local runner →</a><a class="button secondary" href="/examples">Inspect the real CRM case</a></div>'
new = '<div class="hero-actions"><a class="button primary" href="${REPO}/releases/tag/v1.0.0">Install v1.0.0 →</a><a class="button secondary" href="/examples">Inspect the real CRM case</a></div>'
if old not in s:
    raise SystemExit('hero release CTA anchor not found')
s = s.replace(old, new, 1)

old = '<article class="accent"><span>LOCAL RUNNER</span><h3>Mutate a real SQLite target</h3><p>Filesystem CSV → existing ordinary SQLite table, insert-only, with source/target identity binding and crash-safe evidence.</p><a href="${REPO}/blob/main/src/cli/spool.js">Inspect CLI source →</a></article>'
new = '<article class="accent"><span>LOCAL RUNNER</span><h3>Mutate a real SQLite target</h3><p>Filesystem CSV → existing ordinary SQLite table, insert-only, with source/target identity binding and crash-safe evidence.</p><a href="${REPO}/releases/tag/v1.0.0">Open v1.0.0 release →</a></article>'
if old not in s:
    raise SystemExit('runner release link anchor not found')
s = s.replace(old, new, 1)

start = s.index('    <section class="section"><div class="code-workflow"><div><span class="kicker">RUN IT ON YOUR DEVICE</span>')
end = s.index('\n  `);\n}\n\nfunction examplesPage()', start)
replacement = '''    <section class="section"><div class="code-workflow"><div><span class="kicker">INSTALL + RUN ON YOUR DEVICE</span><h2>Install the versioned CLI, then inspect, approve, run and verify.</h2><p>Node.js 22+ is required. Browser Studio stays capped at 50 MiB; for production SQLite mutation or larger CSV files use this customer-local runner. The current local-runner source ceiling is 256 MiB and the source/target/state paths stay on your customer-controlled machine. The release remains private on the npm registry; install directly from the versioned GitHub source or release artifact.</p></div><pre># Preferred v1.0.0 install — no npm-registry publication required.
npm install -g github:dharan1007/spool#v1.0.0
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
git clone --branch v1.0.0 https://github.com/dharan1007/spool.git
cd spool && npm ci && npm run check && npm run pack:verify</pre><div class="hero-actions"><a class="button primary" href="${REPO}/releases/tag/v1.0.0">Download / verify v1.0.0 →</a><a class="button secondary" href="${REPO}/blob/main/docs/LOCAL_RUNNER.md">Open migration.json guide</a><a class="button secondary" href="${REPO}/tree/main/examples/crm-export">Use the verified example</a></div></div></section>'''
s = s[:start] + replacement + s[end:]
p.write_text(s)

smoke = Path('scripts/browser-smoke.py')
b = smoke.read_text()
old = "('/local-runner', 'GATE B', 'target_write'),"
new = "('/local-runner', 'npm install -g github:dharan1007/spool#v1.0.0', 'spool receipt'),"
if old not in b:
    raise SystemExit('browser smoke local-runner anchor not found')
b = b.replace(old, new, 1)
smoke.write_text(b)

print('commercial v1 website patch applied')
