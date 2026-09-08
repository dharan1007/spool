# SPOOL GitHub Discovery Setup

This file records repository settings that cannot be expressed by committed source alone. Keep the wording synchronized with shipped behavior.

## About panel

**Description**

> Local-first autonomous data migrations: infer schemas, build deterministic transforms, validate, recover and export typed data without uploading your dataset.

**Homepage**

`https://spool-webmcp.vercel.app/`

**Topics**

`data-migration`, `etl`, `data-engineering`, `data-quality`, `data-cleaning`, `data-validation`, `schema-inference`, `csv`, `local-first`, `developer-tools`, `webmcp`, `mcp`, `privacy`, `javascript`

Do not add unrelated trending topics simply for search exposure.

## Repository features

Enable:

- Issues
- Discussions
- Projects only when the public roadmap project is actually maintained

Disable an empty Wiki unless it is intentionally used for community-maintained recipes. Versioned technical documentation belongs in `/docs`.

## Discussions categories

Create:

1. **Announcements** — maintainer updates/releases only.
2. **Q&A** — usage and architecture questions.
3. **Ideas** — product proposals before they become implementation issues.
4. **Show and tell** — migrations, fixtures and integrations built with SPOOL.
5. **RFC / design** — durability/security/connector proposals.
6. **Integrations** — destination adapters and ecosystem work.

Pin a welcome post, roadmap post and Show & Tell prompt.

## Social preview

Create/upload a 1280×640 preview with the outcome, not architecture jargon:

```text
DIRTY DATA  →  SPOOL  →  TYPED + VALIDATED DATA

Local-first migration.
No dataset upload.
Deterministic execution.
```

Use a high-contrast layout that remains readable at link-card size. Do not place benchmark numbers on the permanent card because measurements can change.

## Merge / branch policy

Recommended for `main`:

- require the existing `release-gate` status check,
- block force pushes and branch deletion,
- require conversation resolution,
- require pull requests for non-maintainer changes,
- prefer squash merge for external contributions,
- automatically delete merged feature branches,
- keep administrator bypass available only for emergency recovery and document its use.

Do not enable a rule that the current solo-maintainer workflow cannot satisfy; add checks only after they are stable.

## Security / analysis

Where available for the repository/account, enable:

- dependency graph,
- Dependabot alerts,
- Dependabot security updates,
- secret scanning,
- push protection,
- CodeQL/default code scanning.

Add OpenSSF Scorecard only after reviewing its findings and committing to maintain the signal.

## Contributor discovery

Maintain 5–15 real approachable issues rather than mass-generating trivial tasks. Use `good first issue` only when a contributor can complete the issue with a bounded amount of project context.

The repository's contributor landing page is:

`https://github.com/dharan1007/spool/contribute`

## Launch proof

Before a major external launch, confirm:

- canonical production URL is healthy,
- `main` CI is green,
- README quickstart succeeds from a fresh clone,
- built-in 25k migration succeeds,
- benchmark files are regenerated from the current commit,
- no known blocker contradicts the launch claim,
- issues/PRs will receive fast maintainer responses during the launch window.

## Distribution narrative

Lead with the problem:

> Messy migration data usually needs schema inference and repair, but arbitrary generated code is the wrong execution boundary. SPOOL turns dirty CSV into typed validated output through a constrained deterministic pipeline and keeps the current dataset path local to the browser.

Technical follow-ups can then explain Temporal WebMCP, recovery and connector-native reconciliation.