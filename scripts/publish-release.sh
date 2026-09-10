#!/usr/bin/env bash
set -euo pipefail

VERSION="${RELEASE_VERSION:?RELEASE_VERSION is required}"
COMMIT="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
REF="${GITHUB_REF:?GITHUB_REF is required}"
TAG="v${VERSION}"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || { echo "Invalid semantic version: $VERSION" >&2; exit 2; }
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "RELEASE_COMMIT must be an exact lowercase 40-character Git SHA" >&2; exit 2; }
test "$REF" = "refs/heads/main" || { echo "Release publication must be dispatched from refs/heads/main" >&2; exit 2; }

git fetch origin main --depth=1
HEAD_SHA="$(git rev-parse HEAD)"
MAIN_SHA="$(git rev-parse origin/main)"
test "$HEAD_SHA" = "$COMMIT" || { echo "Checked-out SHA $HEAD_SHA does not match requested release SHA $COMMIT" >&2; exit 2; }
test "$MAIN_SHA" = "$COMMIT" || { echo "Requested release SHA is not current origin/main ($MAIN_SHA)" >&2; exit 2; }

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
test "$PACKAGE_VERSION" = "$VERSION" || { echo "package.json version $PACKAGE_VERSION does not match requested version $VERSION" >&2; exit 2; }

npm audit --omit=dev --audit-level=high
SPOOL_COMMIT_SHA="$COMMIT" SPOOL_RELEASE_VERSION="$VERSION" npm run check
SPOOL_COMMIT_SHA="$COMMIT" SPOOL_RELEASE_VERSION="$VERSION" npm run pack:verify

rm -rf release existing-release
mkdir release
PACK_JSON="$(npm pack --json --pack-destination release)"
ARTIFACT_NAME="$(node -e "const x=JSON.parse(process.argv[1]);if(!Array.isArray(x)||!x[0]?.filename)process.exit(2);process.stdout.write(x[0].filename)" "$PACK_JSON")"
ARTIFACT="release/$ARTIFACT_NAME"
test -s "$ARTIFACT"
node scripts/release-manifest.js --version "$VERSION" --commit "$COMMIT" --artifact "$ARTIFACT" --out release/release-record.json
(
  cd release
  sha256sum "$ARTIFACT_NAME" release-record.json > SHA256SUMS
  sha256sum -c SHA256SUMS
)

# Release tags are immutable. Existing tags must already resolve to the exact release commit.
git fetch origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  EXISTING_TAG_SHA="$(git rev-parse "refs/tags/$TAG^{}")"
  test "$EXISTING_TAG_SHA" = "$COMMIT" || { echo "Tag $TAG already points to $EXISTING_TAG_SHA; refusing to move it" >&2; exit 2; }
else
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git tag -a "$TAG" "$COMMIT" -m "SPOOL $TAG"
  git push origin "refs/tags/$TAG"
fi

python3 - "$VERSION" <<'PY'
from pathlib import Path
import sys
version = sys.argv[1]
Path('release-notes.md').write_text(f'''# SPOOL v{version}

Evidence-backed SPOOL release for zero-cost customer-local operation.

## Production-supported scope

- Browser Studio: local-first CSV profiling, deterministic transformation, validation and export; 50 MiB browser boundary.
- Local Runner: UTF-8 filesystem CSV into an existing ordinary SQLite table, INSERT only.
- Source snapshot, live target contract, bound target_write approval, lease/fencing, atomic batch ledger, crash reconciliation, verification and commit-bound receipt.
- Installed `spool` CLI and authenticated loopback `spoold` share the production command service.

## Install

```bash
npm install -g github:dharan1007/spool#v{version}
spool --help
```

The attached package tarball, `SHA256SUMS`, and `release-record.json` provide a verifiable artifact path.

## Explicit boundary

This release does not claim hosted raw-row ingestion, unsupported write strategies, virtual/triggered SQLite targets, or legal/regulatory certification. See `docs/LOCAL_RUNNER.md`, `SECURITY.md`, `docs/DATA_HANDLING.md`, and `docs/CUSTOMER_ENGAGEMENT.md`.
''', encoding='utf-8')
PY

if gh release view "$TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
  # Never mutate or overwrite an existing release. Verify its published evidence instead.
  mkdir existing-release
  gh release download "$TAG" --repo "$REPOSITORY" --dir existing-release --pattern '*.tgz' --pattern 'SHA256SUMS' --pattern 'release-record.json'
  (
    cd existing-release
    sha256sum -c SHA256SUMS
  )
  RELEASE_VERSION="$VERSION" RELEASE_COMMIT="$COMMIT" node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync('existing-release/release-record.json','utf8'));if(r.version!==process.env.RELEASE_VERSION)throw new Error('Existing release version mismatch: '+r.version);if(r.commit!==process.env.RELEASE_COMMIT)throw new Error('Existing release commit mismatch: '+r.commit);if(!r.artifact?.filename||!r.artifact.filename.endsWith('.tgz'))throw new Error('Existing release record lacks package artifact');if(!fs.existsSync('existing-release/'+r.artifact.filename))throw new Error('Existing package artifact named by release record is missing');"
else
  gh release create "$TAG" release/*.tgz release/SHA256SUMS release/release-record.json --verify-tag --title "SPOOL $TAG" --notes-file release-notes.md --repo "$REPOSITORY"
fi

git fetch origin "refs/tags/$TAG:refs/tags/$TAG"
test "$(git rev-parse "refs/tags/$TAG^{}")" = "$COMMIT"
gh release view "$TAG" --json tagName,assets,url --repo "$REPOSITORY" > release/github-release.json
grep -q 'SHA256SUMS' release/github-release.json
grep -q 'release-record.json' release/github-release.json
grep -q '\.tgz' release/github-release.json

echo "SPOOL $TAG release evidence verified at $COMMIT"
