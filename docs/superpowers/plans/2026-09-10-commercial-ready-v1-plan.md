# SPOOL Commercial-Ready v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current verified SPOOL codebase into a zero-cost, installable, professionally operable v1.0.0 release for customer-local commercial engagements.

**Architecture:** Keep the existing Browser Studio and Gate-B command service unchanged as execution authorities. Add packaging, release, install, customer-operation, and website journey layers around them; all release artifacts remain exact-SHA bound and the Vercel Hobby site remains non-commercial/open-source.

**Tech Stack:** Node.js 22+, npm pack/global install, GitHub Actions/Releases, existing ES-module CLI, existing Vercel static build.

**Spec:** `docs/superpowers/specs/2026-09-10-commercial-ready-v1-design.md`

## Global Constraints

- Zero infrastructure spend.
- No npm registry publication is required.
- Preserve `connect-src 'none'` and customer-local SQLite execution.
- Do not claim legal/regulatory certification.
- Protected `main`; release evidence must bind exact Git SHA.
- Existing production scope remains UTF-8 CSV → existing ordinary SQLite table, insert-only.

---

### Task 1: Make the CLI installable from Git/GitHub Release

**Files:**
- Modify: `package.json`
- Test: `tests/cli-package.test.js`

**Interfaces:**
- Produces executable `spool` mapped to `src/cli/spool.js`.
- Produces `npm pack` artifact installable with `npm install -g`.

- [ ] **Step 1: Write the failing package contract test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

test('package exposes spool binary without registry publication', () => {
  assert.equal(pkg.private, true);
  assert.equal(pkg.bin?.spool, 'src/cli/spool.js');
  assert.ok(pkg.files.includes('src'));
  assert.ok(pkg.files.includes('docs'));
  assert.ok(pkg.files.includes('examples'));
});
```

- [ ] **Step 2: Run `node --test tests/cli-package.test.js` and verify it fails**

Expected: missing `bin.spool` / package files.

- [ ] **Step 3: Add package metadata**

Set:

```json
"bin": { "spool": "src/cli/spool.js" },
"files": ["src", "docs", "examples", "LICENSE", "README.md", "SECURITY.md", "ROADMAP.md"],
"scripts": {
  "pack:verify": "node scripts/verify-package.js"
}
```

Keep `private: true` to block accidental registry publication.

- [ ] **Step 4: Run focused package tests and existing CLI tests**

Run: `node --test tests/cli-package.test.js tests/cli.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: package spool cli for direct install`

### Task 2: Verify packed/global-installed CLI and CRM execution

**Files:**
- Create: `scripts/verify-package.js`
- Create: `tests/installed-cli.test.js`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- `scripts/verify-package.js` creates an npm pack tarball in a temporary directory, installs it into a temporary prefix, locates the `spool` binary, checks `--help`, and executes the canonical CRM migration fixture.

- [ ] **Step 1: Add a failing test that invokes `npm pack --json` and asserts the tarball contains `src/cli/spool.js` and `package.json` bin metadata**.
- [ ] **Step 2: Run it and confirm failure before helper exists**.
- [ ] **Step 3: Implement `verify-package.js` using `mkdtemp`, `spawnSync`, `npm pack --json`, `npm install --prefix <tmp> --global <tgz>`, and the installed binary path (`bin/spool` on POSIX, `spool.cmd` on Windows)**.
- [ ] **Step 4: Use a copied `examples/crm-export` workspace, generate a local approval key, run `inspect`, `dry-run`, `approve`, `run`, and `receipt` through the installed binary, then assert the same 5 source / 3 written / 2 rejected CRM evidence**.
- [ ] **Step 5: Add `npm run pack:verify` to the Ubuntu `verify` job and to the SQLite portability matrix so installability is checked on Linux, Windows, macOS**.
- [ ] **Step 6: Run `npm run pack:verify` locally/CI and confirm PASS**.
- [ ] **Step 7: Commit** with `test: verify installed spool package end to end`.

### Task 3: Add customer engagement/delivery templates

**Files:**
- Create: `docs/CUSTOMER_ENGAGEMENT.md`
- Create: `docs/AUTHORIZATION_TEMPLATE.md`
- Create: `docs/DELIVERY_ACCEPTANCE_TEMPLATE.md`
- Create: `docs/CASE_STUDY_CONSENT_TEMPLATE.md`
- Modify: `docs/MIGRATION_SERVICES.md`
- Modify: `README.md`
- Test: `tests/commercial-readiness.test.js`

**Interfaces:**
- Produces a zero-cost operating path from assessment to accepted delivery.

- [ ] **Step 1: Write a failing documentation contract test** asserting each document exists and contains the required boundaries: metadata-only public intake, private payment details, written target authorization, backup/restore responsibility, receipt handoff, written acceptance, optional anonymized case-study consent, and explicit non-legal-template wording.
- [ ] **Step 2: Run the test and verify missing-file failures**.
- [ ] **Step 3: Write the four documents with copy-paste templates and no personal financial/address data**.
- [ ] **Step 4: Link the workflow from README/services docs**.
- [ ] **Step 5: Run the focused test; expected PASS**.
- [ ] **Step 6: Commit** with `docs: add zero-cost customer operating workflow`.

### Task 4: Make the website installation journey actionable

**Files:**
- Modify: `src/product-surface.js`
- Modify: `product.css` only if layout requires it
- Test: `tests/product-surface.test.js`
- Test: `scripts/browser-smoke.py`

**Interfaces:**
- `/local-runner` shows `npm install -g github:dharan1007/spool#v1.0.0` as the preferred released install command and clone/source verification as fallback.
- `/services` remains non-commercial checkout-free on Hobby.

- [ ] **Step 1: Add failing assertions for release install command, release link, and customer-local language**.
- [ ] **Step 2: Run focused tests and confirm failure**.
- [ ] **Step 3: Update product surface copy and commands, retaining CSP-safe markup**.
- [ ] **Step 4: Extend browser smoke to assert `/local-runner` contains released-install and local-data boundary copy**.
- [ ] **Step 5: Run product tests + browser smoke; expected PASS**.
- [ ] **Step 6: Commit** with `feat: expose release install journey`.

### Task 5: Add durable GitHub release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `scripts/release-manifest.js`
- Test: `tests/release-packaging.test.js`

**Interfaces:**
- Workflow accepts `workflow_dispatch` inputs `version` and `commit_sha`.
- It verifies `commit_sha` equals protected main, checks out exact SHA, runs `npm ci`, `npm run check`, `npm run pack:verify`, creates `.tgz`, SHA256SUMS, `release-record.json`, tags `v<version>` if absent, and creates/updates GitHub Release with assets.

- [ ] **Step 1: Add failing workflow/content contract tests** checking exact-SHA verification, permissions `contents: write`, and asset names.
- [ ] **Step 2: Implement `release-manifest.js` to emit canonical JSON containing version, commit SHA, artifact filename, artifact SHA-256, supported scope, and build timestamp**.
- [ ] **Step 3: Implement release workflow using `gh release create`/`gh release upload --clobber`, failing if the supplied SHA differs from `git rev-parse origin/main`**.
- [ ] **Step 4: Run static/workflow contract tests; expected PASS**.
- [ ] **Step 5: Commit** with `ci: add exact-sha github release pipeline`.

### Task 6: Repository hygiene and stale work reconciliation

**Files:**
- No product code changes.

- [ ] **Step 1:** Verify issues #9–#12 acceptance work exists in current tests/docs.
- [ ] **Step 2:** Close #9–#12 with concise evidence links and state reason `completed`.
- [ ] **Step 3:** Close PR #3 as superseded by Gate B; do not merge it.
- [ ] **Step 4:** Verify there are no other stale open production PRs that should merge into v1.0.0.

### Task 7: Freeze, merge and independently verify Release Train 1

**Files:** none beyond prior tasks.

- [ ] **Step 1:** Open PR `release: commercial-ready v1.0.0` from `release/commercial-ready-v1` to `main`.
- [ ] **Step 2:** Wait for exact-head release-gate, SQLite matrix, and CodeQL.
- [ ] **Step 3:** Resolve any review/security findings; rerun until green.
- [ ] **Step 4:** Merge with `expected_head_sha` and squash.
- [ ] **Step 5:** Verify protected-main release-gate and CodeQL on the resulting merge SHA.

### Task 8: Create v1.0.0 Release and deploy exact release

**Files:** no main changes; ops-only trigger permitted.

- [ ] **Step 1:** Trigger the durable release workflow for `1.0.0` and exact merged SHA. If the connector cannot dispatch it, create an ops-only branch workflow that invokes the same commands against the exact SHA; never merge the ops workflow.
- [ ] **Step 2:** Verify GitHub Release `v1.0.0` exists, target commit equals merged main, and `.tgz`, `SHA256SUMS`, `release-record.json` are attached.
- [ ] **Step 3:** Deploy exact merged SHA to Vercel using the existing exact-source builder path.
- [ ] **Step 4:** Verify canonical `/release.json`, `/local-runner`, security headers, and product routes.
- [ ] **Step 5:** Run external Chrome public production smoke and require 0 runtime exceptions, failed network loads, and warning/error logs.
- [ ] **Step 6:** Query Vercel runtime error clusters; require none for the release window.

### Task 9: Final commercial-ready evidence snapshot

**Files:**
- Modify: `docs/PRODUCTION_AUDIT.md`
- Modify: `README.md`

- [ ] **Step 1:** Record v1.0.0 tag/release SHA, installed-package smoke platforms, CRM fixture result, live deployment id, public Chrome smoke result, and explicit unsupported scope.
- [ ] **Step 2:** Run full release gate once more if the evidence update changes main through a PR; otherwise keep the release artifact immutable and put post-release evidence in a `v1.0.0` audit issue rather than changing the tagged tree.
