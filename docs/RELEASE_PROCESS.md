# SPOOL Release Process

SPOOL production releases are accepted only when the deployed static artifact can be tied back to a verified Git commit and the real browser workflow passes.

## Required chain

1. A change lands through a pull request.
2. `release-gate` runs unit/integration/security/build/benchmark/static checks.
3. The same gate runs `scripts/browser-smoke.py` against the built `dist/` directory in headless Chrome/Chromium.
4. CodeQL must be green for JavaScript/TypeScript changes.
5. The production build receives `SPOOL_COMMIT_SHA=<40-char git sha>` and emits `dist/release.json`.
6. The merged commit is deployed to the production Vercel project.
7. `/release.json` is fetched from production and its `commit` value is compared with the intended merged main SHA.
8. `scripts/browser-smoke.py https://spool-webmcp.vercel.app` must pass against the production deployment.
9. Runtime error clusters/logs are reviewed after deployment before stronger readiness claims are published.

## Release manifest

`release.json` schema v1:

```json
{
  "schemaVersion": 1,
  "version": "1.0.0",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "builtAt": "2026-09-09T09:30:00.000Z",
  "transport": "same-origin-es-modules"
}
```

A local build may contain `commit: null`; production may not be accepted when the deployed manifest is unbound or points to a different source revision.

## Rollback

Rollback is allowed only to a previously verified deployment. After rollback, repeat the public browser smoke and fetch `/release.json` to record the active source revision. Do not call a rollback successful solely because Vercel reports `READY`.

## Evidence rule

Build success, deployment success and migration correctness are separate claims. Each must be backed by its own current evidence. Documentation/README capability claims may be promoted only after their corresponding automated gate is green on the exact shipped revision.
