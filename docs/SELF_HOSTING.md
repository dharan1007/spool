# Self-hosting SPOOL

SPOOL's public web surface is a static application. Browser Studio keeps the dataset plane local to the browser and the production CSP denies application network connections with `connect-src 'none'`. The hosted web application is not the SQLite mutation service; real target writes run through the Local Runner or loopback `spoold` on the operator-controlled machine.

## Build an exact release

Requirements: Node.js 22+ and the committed lockfile.

```bash
git clone https://github.com/dharan1007/spool.git
cd spool
npm ci
npm run check
export SPOOL_COMMIT_SHA="$(git rev-parse HEAD)"
npm run build
```

The build produces `dist/` and `dist/release.json`. A production release must contain the exact 40-character Git commit in `release.json`; do not invent or replace release identity after the build.

## Run the enterprise daemon container

The repository `Dockerfile` builds a non-root image (`node`, uid 1000) whose
entrypoint is `node src/daemon/spoold-v2-main.js` and whose state directory is
the `/var/lib/spool` volume. The daemon binds `127.0.0.1` inside the container,
so publish nothing directly: front it with the same-pod proxy from `helm/spool`
or exec inside it.

```bash
docker build -t spool-daemon .
docker run -d --name spool-daemon \
  -v spool-state:/var/lib/spool \
  -e SPOOL_DAEMON_TOKEN="<at least 32 bytes>" \
  -e SPOOL_APPROVAL_SIGNING_KEY="<at least 32 bytes>" \
  -e SPOOL_RELEASE_COMMIT_SHA="$(git rev-parse HEAD)" \
  spool-daemon
```

The daemon refuses to start without those three values and exits non-zero with
`INVALID_DAEMON_CONFIG`, so a misconfigured deployment fails closed instead of
serving unauthenticated state.

A fresh volume has no organization, and every workspace belongs to one. With
the root bearer token provision it in product order:

```bash
curl -sS -X POST http://127.0.0.1:8080/v2/organizations \
  -H "authorization: Bearer $SPOOL_DAEMON_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"your-org"}'
# then POST /v2/workspaces with that organizationId, and
# POST /v2/workspaces/{id}/apikeys for per-workspace operator/viewer keys
```

`scripts/qualify-container.js` is the in-container acceptance check: copy it in
(`docker cp`) and run it as the image user. It exercises health/ready/metrics,
the fail-closed transport cases (401, 421, invalid JSON), organization,
workspace and API-key provisioning, a real CSV -> SQLite migration through
plan/dry-run/approve/execute/receipt/verification, and row-level verification of
the durable target. It exits non-zero on the first failed check.

## Static hosting requirements

Serve `dist/` as same-origin static files and configure SPA fallback so application routes such as `/studio/new`, `/local-runner`, `/security`, and `/services` resolve to `index.html` instead of returning a hosting-layer 404.

Keep the release security headers and CSP intact. In particular, do not solve rendering problems by adding `unsafe-inline` or relaxing `connect-src 'none'`. The release gate rejects application network primitives and inline style attributes that would violate the strict production policy.

## What the web host receives

The intended hosted surface serves application assets and documentation. Browser Studio parses and transforms selected CSV files in the user's browser. Production SQLite mutation is not performed by a remote web endpoint and target database credentials are not sent to this site.

For a real SQLite migration, follow `docs/LOCAL_RUNNER.md` on the device that owns the source and target.

## Commercial use and hosting terms

Use infrastructure and a hosting plan whose terms permit your intended production/commercial use. The canonical public SPOOL deployment is intentionally presented as a non-commercial documentation/Browser Studio surface while it is hosted on a personal Hobby workspace. Do not add payment collection or commercial transaction claims to that Hobby-hosted surface without first moving it to a plan/provider that permits the intended use.

## Release verification

Before promoting a build:

1. `npm ci` succeeds with the committed lockfile.
2. `npm run check` is green.
3. Release-gate Browser smoke is green against the built `dist/` output.
4. SQLite conformance is green on Linux, Windows, and macOS.
5. CodeQL is green.
6. `dist/release.json` matches the exact candidate Git SHA.
7. After deployment, fetch `/release.json` and verify it still matches the merged SHA.
8. Run the production Browser smoke against the canonical hostname.

If post-deploy verification fails, roll back to the last exact SHA with known-green release evidence rather than patching the live artifact manually.