# Production Repository Governance

SPOOL treats release provenance as part of migration correctness. A production build should not be promotable from an unreviewed direct push.

## Required protection for `main`

Configure the repository so `main` requires a pull request before merge and cannot be force-pushed or deleted. Require the production checks that exist in this repository, including:

- `release-gate` / its verify job.
- SQLite portability/conformance jobs on Linux, Windows, and macOS.
- CodeQL JavaScript analysis.

Do not allow ordinary direct pushes to bypass these checks. If GitHub offers administrator/bypass controls, keep the bypass list as small as operationally possible and use bypass only for documented incident recovery.

The connected automation used to maintain this repository does not have GitHub administration permission to write branch-protection/ruleset settings. Therefore this repository setting must be applied by a repository administrator in GitHub itself.

## GitHub UI procedure

1. Open the `dharan1007/spool` repository.
2. Open **Settings** → **Rules** → **Rulesets** (or the branch-protection section available to the account).
3. Create a branch ruleset targeting the default branch / `main`.
4. Require a pull request before merge.
5. Require successful status checks before merge and select the release-gate, SQLite portability/conformance, and CodeQL checks.
6. Block force pushes and branch deletion.
7. Enable the ruleset and verify it is active by confirming a direct update to `main` is no longer the normal release path.

## Release chain

The intended chain is:

```text
feature/fix branch
  -> pull request
  -> release-gate + Browser smoke
  -> SQLite portability/conformance
  -> CodeQL
  -> merge exact SHA
  -> build with exact SHA
  -> deploy
  -> verify /release.json
  -> production Browser smoke
```

A deployment whose `/release.json` cannot be tied to the merged source SHA is not a valid SPOOL production release.

## Emergency rollback

Rollback should promote the last exact Git SHA with known-green release and post-deploy evidence. Do not hot-edit generated production assets because that breaks provenance between repository, release manifest, and deployed behavior.