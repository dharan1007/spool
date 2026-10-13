#!/usr/bin/env bash
set -euo pipefail

VERSION="${RELEASE_VERSION:?RELEASE_VERSION is required}"
COMMIT="${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
REPOSITORY="${RELEASE_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Set RELEASE_REPOSITORY=owner/repo before manual publishing' >&2; exit 2; }
REF="$(git symbolic-ref HEAD)"
TAG="v${VERSION}"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || { echo "Invalid semantic version: $VERSION" >&2; exit 2; }
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "RELEASE_COMMIT must be an exact lowercase 40-character Git SHA" >&2; exit 2; }
test "$REF" = "refs/heads/main" || { echo "Release publication must run on local refs/heads/main; got $REF" >&2; exit 2; }

git fetch origin main --depth=1
HEAD_SHA="$(git rev-parse HEAD)"
MAIN_SHA="$(git rev-parse origin/main)"
test "$HEAD_SHA" = "$COMMIT" || { echo "Checked-out SHA $HEAD_SHA does not match requested release SHA $COMMIT" >&2; exit 2; }
test "$MAIN_SHA" = "$COMMIT" || { echo "Requested release SHA is not current origin/main ($MAIN_SHA)" >&2; exit 2; }

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
test "$PACKAGE_VERSION" = "$VERSION" || { echo "package.json version $PACKAGE_VERSION does not match requested version $VERSION" >&2; exit 2; }

npm audit --omit=dev --audit-level=high
npm ci
QUALIFICATION_LOG="$(mktemp "${TMPDIR:-/tmp}/spool-publication-XXXXXX")"
SPOOL_COMMIT_SHA="$COMMIT" SPOOL_RELEASE_VERSION="$VERSION" node scripts/qualify-bounded-release.js | tee "$QUALIFICATION_LOG"
# Any failure above stops before tag creation, push, or publication.

REPORT="$(sed -n 's/^Evidence: //p' "$QUALIFICATION_LOG")"
test -n "$REPORT"
PUBLICATION_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/spool-publication-assets-XXXXXX")"
PUBLICATION_DIR="$PUBLICATION_PARENT/assets"
node scripts/prepare-release-publication.js "$REPORT" "$COMMIT" "$VERSION" "$PUBLICATION_DIR"
(
  cd "$PUBLICATION_DIR"
  sha256sum -c SHA256SUMS
)

# Release tags are immutable. Existing tags must already resolve to the exact release commit.
git fetch origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  EXISTING_TAG_SHA="$(git rev-parse "refs/tags/$TAG^{}")"
  test "$EXISTING_TAG_SHA" = "$COMMIT" || { echo "Tag $TAG already points to $EXISTING_TAG_SHA; refusing to move it" >&2; exit 2; }
else
  # Preserve the real local release operator's configured identity.
  git var GIT_AUTHOR_IDENT >/dev/null
  git tag -a "$TAG" "$COMMIT" -m "SPOOL $TAG"
  git push origin "refs/tags/$TAG"
fi

python3 - "$VERSION" "$PUBLICATION_PARENT/release-notes.md" <<'PY'
from pathlib import Path
import sys
version = sys.argv[1]
Path(sys.argv[2]).write_text(f'''# SPOOL v{version}

Evidence-backed SPOOL release for zero-cost customer-local operation.

## Production-supported scope

- Browser Studio: local-first CSV/XLSX profiling, deterministic transformation, durable recovery, validation and CSV/JSON export; 50 MiB source boundary.
- Local Runner: UTF-8 filesystem CSV into an existing ordinary SQLite table, INSERT only.
- Source snapshot, live target contract, bound target_write approval, lease/fencing, atomic batch ledger, crash reconciliation, verification and commit-bound receipt.
- Installed `spool` CLI and authenticated loopback `spoold` share the production command service.

## Install

```bash
npm install -g github:dharan1007/spool#v{version}
spool --help
```

The attached package tarball is the exact installed and qualified artifact. `SHA256SUMS`, `release-record.json`, `qualification.json`, `parity-evidence.json`, the enrolled public key and signature verification receipt retain its release evidence.

## Explicit boundary

This release does not claim hosted raw-row ingestion, unsupported write strategies, virtual/triggered SQLite targets, or legal/regulatory certification. See `docs/LOCAL_RUNNER.md`, `SECURITY.md`, `docs/DATA_HANDLING.md`, and `docs/CUSTOMER_ENGAGEMENT.md`.
''', encoding='utf-8')
PY

if gh release view "$TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
  # Never mutate or overwrite an existing release. Verify its published evidence instead.
  EXISTING_DIR="$PUBLICATION_PARENT/existing-release"
  mkdir "$EXISTING_DIR"
  gh release download "$TAG" --repo "$REPOSITORY" --dir "$EXISTING_DIR" --pattern '*.tgz' --pattern 'SHA256SUMS' --pattern 'release-record.json' --pattern 'parity-evidence.json' --pattern 'qualification.json' --pattern 'signature-receipt.json' --pattern 'release-public.key'
  (
    cd "$EXISTING_DIR"
    sha256sum -c SHA256SUMS
  )
  RELEASE_VERSION="$VERSION" RELEASE_COMMIT="$COMMIT" EXISTING_DIR="$EXISTING_DIR" PUBLICATION_DIR="$PUBLICATION_DIR" node -e "const fs=require('fs'),path=require('path');const r=JSON.parse(fs.readFileSync(path.join(process.env.EXISTING_DIR,'release-record.json'),'utf8'));const candidate=JSON.parse(fs.readFileSync(path.join(process.env.PUBLICATION_DIR,'release-record.json'),'utf8'));if(r.version!==process.env.RELEASE_VERSION||r.commit!==process.env.RELEASE_COMMIT||r.artifact?.sha256!==candidate.artifact.sha256||r.artifactRootSha256!==candidate.artifactRootSha256)throw new Error('Existing immutable release identity differs from qualified artifact');"
else
  gh release create "$TAG" "$PUBLICATION_DIR"/*.tgz "$PUBLICATION_DIR/SHA256SUMS" "$PUBLICATION_DIR/release-record.json" "$PUBLICATION_DIR/qualification.json" "$PUBLICATION_DIR/parity-evidence.json" "$PUBLICATION_DIR/signature-receipt.json" "$PUBLICATION_DIR/release-public.key" --verify-tag --title "SPOOL $TAG" --notes-file "$PUBLICATION_PARENT/release-notes.md" --repo "$REPOSITORY"
fi

git fetch origin "refs/tags/$TAG:refs/tags/$TAG"
test "$(git rev-parse "refs/tags/$TAG^{}")" = "$COMMIT"
gh release view "$TAG" --json tagName,assets,url --repo "$REPOSITORY" > "$PUBLICATION_PARENT/github-release.json"
grep -q 'SHA256SUMS' "$PUBLICATION_PARENT/github-release.json"
grep -q 'release-record.json' "$PUBLICATION_PARENT/github-release.json"
grep -q '\.tgz' "$PUBLICATION_PARENT/github-release.json"

echo "SPOOL $TAG release evidence verified at $COMMIT"
