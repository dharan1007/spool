# SPOOL external PostgreSQL qualification (GitHub-hosted quota exhausted)

GitHub-hosted Actions minutes can be exhausted without making SPOOL's industrial PostgreSQL guarantees true or false. The alternative is to execute the **same actual code paths** in an isolated, trusted Linux runner; do not change assertions, remove test suites, suppress failing checks, or promote the experimental connector. See [readiness and P0 register #74](https://github.com/dharan1007/spool/issues/74).

## Direct local/independent runner (requires no GitHub Actions)

Use a dedicated Linux x64 VM, or Windows with WSL2 Ubuntu, with Git, Node.js 22, npm, Python 3, Chromium, and isolated PostgreSQL 17 configured with `wal_level=logical`. The PostgreSQL test suite creates, mutates and drops objects: NEVER aim it at a customer or production database. Provide CodeQL CLI for the security scan; CodeQL licensing/availability for a private repository must be checked separately. Python `websocket-client` and a working Chromium/Chrome executable are mandatory for the standalone browser gate; missing browser dependencies fail closed, never silently skip the smoke run. Install dependencies from the pinned lockfile, not from untrusted scripts.

Checkout an exact reviewed commit on the experimental/qualification branch, and use its clean worktree. Before execution, integrate red-team PR #72's tests for contract races and natural stale-lease takeover; the offline gate **refuses** to proceed without those files:

```bash
git checkout <exact-reviewed-commit-sha>
git status --porcelain
export SPOOL_TEST_POSTGRES_ENDPOINT='postgresql://127.0.0.1:5432/?sslmode=disable'
export SPOOL_TEST_POSTGRES_DATABASE='spooltest'
export SPOOL_TEST_POSTGRES_USER='spooltest'
export SPOOL_TEST_PG_PASSWORD='<test-only-password>'
export SPOOL_EXTERNAL_EVIDENCE_ROOT="$HOME"
bash scripts/qualify/external-ci.sh "$(git rev-parse HEAD)"
```

The script checks the exact SHA, clean checkout, real PostgreSQL credentials and presence of the two red-team tests. It then executes `npm ci`, the production dependency audit, unit/integration/model/static/build/package/release checks, a real Chromium smoke run against the built SPA (screenshot stored and checksummed OUTSIDE the checkout), the entire real PostgreSQL conformance test set, red-team tests, snapshot materialization, actual CI-sized PostgreSQL qualification, the independent evidence verifier, and the CodeQL CLI. Missing CodeQL is a hard refusal. Its evidence directory is outside the worktree, and includes per-command output, exit statuses and SHA-256 checksums. SHA-256 checksums alone do **not** make the resulting evidence an independently signed or tamper-proof release receipt.

When the environment is not ready, it exits nonzero. A passing run records only `DEVELOPMENT_EVIDENCE_ONLY` and `RELEASE_AUTHORIZED=NO`. It does **not** establish sustained soak, hard SIGKILL recovery, natural lease takeover, multi-party approval, production IAM, multiversion/HA qualification, Windows/macOS portability, or 10M/100M/1B-row scale.

## Self-hosted GitHub runner is a separate option

GitHub currently documents self-hosted Actions usage as free of GitHub-hosted minutes; the December 2025 announced private-runner billing change was postponed. To use one, an owner must register a dedicated isolated machine at **Settings → Actions → Runners → New self-hosted runner**. Follow the generated instructions; do not paste runner tokens into chat, repository files or logs. A runner cannot safely process unreviewed contributions while holding production credentials. A self-hosted runner must still run the mandatory actual checks; it cannot be a decorative always-green status. Account policy may still prevent a workflow from starting, and registration is not executable through the connected repository tool here.

A dedicated experimental workflow, `.github/workflows/selfhosted-industrial-postgres.yml`, uses `runs-on: [self-hosted, linux, x64, spool-industrial]`. Register a Linux x64 runner with the **additional `spool-industrial` label**, Node 22, CodeQL CLI, network access, Docker and an owner-only `/var/lib/spool-qualification/evidence` directory. Its `push` trigger is limited to the two reviewed industrial/qualification branches. The workflow has read-only repository permissions and uses test-only PostgreSQL credentials. It executes the strict local gate; it does not publish a production release. Prepare the evidence directory on the runner with `sudo install -d -m 0700 -o "$USER" /var/lib/spool-qualification/evidence` before running. Do not mount production secrets on this runner. A queued job is NOT_EXECUTED, never green.

The existing `.github/workflows/ci.yml` uses GitHub-hosted Linux/Windows/macOS runners. The external script does not magically satisfy or replace those check names. An administrator must enforce PR-only releases and a real mandatory qualified runner gate before production promotion. Do not expose secrets or make the private repository public merely to obtain free hosted minutes.

## Evidence requirements beyond this script

For every attempted class, bind the exact commit, source/target PostgreSQL vendor+version+patch and topology, capture mechanism, test corpus/seed, CPU/RSS/disk/WAL, throughput, p50/p95/p99, checkpoint lag, CDC soak, RPO/RTO, recovery and verification/repair convergence. The separate INDUSTRIAL qualification must additionally establish security, key custody/rotation, approval separation, repair/cutover crash matrices, signed receipts, immutable archival, operator support and platform/version certification. Any missing/failed gate is NOT_QUALIFIED. Current production scope remains v1.1.1's bounded browser/local CSV→SQLite product.

For account-quota facts, consult the [official GitHub Actions billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
