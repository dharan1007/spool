# SPOOL Complete Web Product Deployment Design

## Goal

Replace the stale September 4 Vercel artifact with the current SPOOL product and make the website represent the full product truthfully: a working browser Studio plus first-class product surfaces for the verified local CSV-to-SQLite runner, real example evidence, security guarantees, and the solo-builder service offers.

## Product boundary

The website must not pretend the production SQLite runner executes inside the browser or on a hosted SPOOL backend. The browser Studio remains a local-first browser data plane with `connect-src 'none'`. The Gate-B runner remains a customer-local Node.js/SQLite execution path exposed through CLI and `spoold`.

The website must expose both surfaces as one coherent product:

1. Browser Studio for CSV profiling, deterministic transformation, validation, checkpoints, violations, and export.
2. Local runner for approved UTF-8 filesystem CSV -> existing ordinary SQLite table migrations with source snapshot binding, target preflight/contract fingerprint, bound approval, durable leases/fencing, atomic row+ledger commits, crash reconciliation, verification, and commit-bound receipts.

## Routes

Keep the existing working routes:

- `/`
- `/autopilot`
- `/how-it-works`
- `/webmcp`
- `/benchmarks`
- `/docs`
- `/studio`
- `/studio/new`
- `/studio/mission`
- `/studio/results`

Add first-class routes:

- `/local-runner` — supported Gate-B workflow, exact capability matrix, installation/run commands, approval/recovery/receipt flow, and explicit unsupported operations.
- `/examples` — checked-in CRM migration case with the real dirty inputs, target contract, deterministic rejection behavior, and exact evidence produced by the production command service.
- `/security` — browser/local-runner trust boundaries, CSP, source/target identity binding, path containment, approvals, fencing, reconciliation, verification, receipts, and fail-closed states.
- `/services` — current solo-builder paid outcomes: Migration Preflight, Import-Ready Dataset, Migration Rescue, and Verified CSV -> SQLite Migration; no hosted checkout or SaaS subscription claim.

## Navigation and homepage

The top navigation must make the two execution surfaces discoverable without becoming crowded. Public navigation should prioritize Product, Local Runner, Examples, Security, and Docs, while Studio remains a prominent action.

The homepage must stop calling SPOOL a demo. It must explain that SPOOL has a browser-local Studio and a production-verified local runner, show which path to use for which job, and link directly to the new routes. It must retain the current Autopilot and WebMCP story only as part of the browser surface rather than as the whole product identity.

## Security constraints

- Preserve the current CSP, including `connect-src 'none'`.
- Do not add analytics, hosted raw-row ingestion, client-side external API calls, WebSockets, or payment SDKs.
- Do not expose secrets, credentials, bank details, or personal identifiers.
- Do not claim PostgreSQL/MySQL, remote database execution, upsert/replace/delete/truncate, triggered SQLite targets, virtual tables, or unlimited browser file size.
- Do not add a browser path that calls `spoold`; the local daemon remains loopback-only and separately authenticated.

## Deployment provenance

The deployed website is accepted only when all of the following are true:

1. The release branch passes `npm ci`, production dependency audit, full tests, build, benchmark, static checks, real Chrome built-artifact smoke, Linux/Windows/macOS SQLite conformance, and CodeQL.
2. The feature PR is merged to `main` with the expected head SHA.
3. The actual merged `main` SHA independently passes the release gate and CodeQL.
4. The Vercel deployment is built from or bound to that exact merged SHA.
5. `/release.json` on the canonical live domain reports the exact merged commit.
6. Live deep links for `/local-runner`, `/examples`, `/security`, `/services`, and Studio routes return the current SPA.
7. The production browser smoke passes against the canonical domain with no runtime/network-console failures.

## Commercial boundary

The canonical website may explain the solo-builder services and link to the repository's metadata-only Migration Assessment path, but the Vercel-hosted application remains a static product/documentation surface. Customer datasets and production SQLite execution remain local. Payment details are exchanged privately; no hosted checkout is required.

## Success criteria

A new visitor can answer, from the website alone:

- what SPOOL does;
- what runs in-browser versus locally;
- how to use the local runner;
- what exact SQLite scope is production-supported;
- what evidence SPOOL produces;
- how crash/replay safety works;
- what real example proves the path;
- what is unsupported;
- which paid outcomes the solo builder offers;
- where to start a browser migration or request an assessment.

The canonical Vercel site must no longer serve the stale September 4 product artifact.