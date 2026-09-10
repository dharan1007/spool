#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


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

p = ROOT / 'src/product-surface.js'
s = p.read_text(encoding='utf-8')
s = replace_once(s, "const ASSESSMENT = `${REPO}/issues/new?template=migration-assessment.yml`;\n", "", 'remove commercial assessment constant')
old = '''    <section class="section"><div class="code-workflow"><div><span class="kicker">RUN IT LOCALLY</span><h2>Install from the verified repository.</h2><p>Node.js 22+ is required. The committed lockfile pins the production SQLite dependency graph.</p></div><pre>git clone https://github.com/dharan1007/spool.git
cd spool
npm ci
npm run check
node src/cli/spool.js --help</pre></div></section>
'''
new = '''    <section class="section"><div class="code-workflow"><div><span class="kicker">RUN IT ON YOUR DEVICE</span><h2>Clone, verify, configure, inspect, approve, run.</h2><p>Node.js 22+ is required. Browser Studio stays capped at 50 MiB; for production SQLite mutation or larger CSV files use this customer-local runner. The current local-runner source ceiling is 256 MiB and the source/target/state paths stay on your machine.</p></div><pre>git clone https://github.com/dharan1007/spool.git
cd spool
npm ci
npm run check

# Generate a local approval-signing key and bind the exact checkout.
export SPOOL_APPROVAL_KEY="$(openssl rand -hex 32)"
export SPOOL_COMMIT_SHA="$(git rev-parse HEAD)"

# Create migration.json from docs/LOCAL_RUNNER.md, then use the same roots/state file.
node src/cli/spool.js inspect --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db
node src/cli/spool.js plan --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db
node src/cli/spool.js dry-run --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db
node src/cli/spool.js approve --request migration.json --source-root ./data --target-root ./data --state ./data/spool-state.db --expires 2026-12-31T23:59:59Z --nonce first-run --out approval.json
node src/cli/spool.js run --request migration.json --approval approval.json --source-root ./data --target-root ./data --state ./data/spool-state.db --out run-result.json
node src/cli/spool.js status --migration-id mig_customers_001 --source-root ./data --target-root ./data --state ./data/spool-state.db
node src/cli/spool.js verify --migration-id mig_customers_001 --source-root ./data --target-root ./data --state ./data/spool-state.db
node src/cli/spool.js receipt --migration-id mig_customers_001 --source-root ./data --target-root ./data --state ./data/spool-state.db --out receipt.json</pre><div class="hero-actions"><a class="button primary" href="${REPO}/blob/main/docs/LOCAL_RUNNER.md">Open full migration.json guide →</a><a class="button secondary" href="${REPO}/tree/main/examples/crm-export">Use the verified example</a></div></div></section>
'''
s = replace_once(s, old, new, 'local-runner copyable commands')

start = 'function servicesPage() {'
end = 'function productPage(path) {'
services = '''function servicesPage() {
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
s = replace_between(s, start, end, services, 'replace hosted commercial services page')
p.write_text(s, encoding='utf-8')

p = ROOT / 'scripts/static-check.js'
s = p.read_text(encoding='utf-8')
needle = "  if (/\\beval\\s*\\(/.test(text) || /new\\s+Function\\s*\\(/.test(text)) failures.push(`${file}: arbitrary code execution primitive detected`);\n"
s = replace_once(s, needle, needle + "  if (/\\sstyle\\s*=\\s*['\"]/i.test(text)) failures.push(`${file}: inline style attribute violates strict production CSP`);\n", 'static inline-style policy')
p.write_text(s, encoding='utf-8')

print('Product surface and static CSP gate patched.')
