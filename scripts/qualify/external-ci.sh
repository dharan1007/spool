#!/usr/bin/env bash
# External, quota-independent, FAIL-CLOSED PostgreSQL development qualification.
# This is not an industrial certificate or a substitute for independent review.
set -Eeuo pipefail
umask 077

fail() { printf 'SPOOL_EXTERNAL_GATE: %s\n' "$*" >&2; exit 2; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "required command missing: $1"; }

[[ $# -eq 1 ]] || fail 'usage: bash scripts/qualify/external-ci.sh EXACT_40_CHAR_COMMIT_SHA'
[[ "$1" =~ ^[0-9a-fA-F]{40}$ ]] || fail 'an exact 40-hex commit SHA is required'
require_command git
require_command node
require_command npm
require_command sha256sum
require_command date
require_command realpath
repo=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run from a Git checkout'
cd "$repo"
sha=$(git rev-parse HEAD)
[[ "${sha,,}" == "${1,,}" ]] || fail "wrong checkout: requested $1 actual $sha"
[[ -z $(git status --porcelain --untracked-files=all) ]] || fail 'dirty checkout; qualification must bind immutable source'
[[ $(node -p 'Number(process.versions.node.split(".")[0])') -ge 22 ]] || fail 'Node.js >=22 is required'
[[ -n ${SPOOL_TEST_POSTGRES_ENDPOINT:-} ]] || fail 'SPOOL_TEST_POSTGRES_ENDPOINT is required for real PostgreSQL'
[[ -n ${SPOOL_TEST_PG_PASSWORD:-} ]] || fail 'SPOOL_TEST_PG_PASSWORD is required for real PostgreSQL'
[[ -f tests/industrial-postgres-contract-race.test.js ]] || fail 'red-team contract race test missing; integrate PR #72 before release qualification'
[[ -f tests/industrial-postgres-lease-recovery.test.js ]] || fail 'red-team stale-lease test missing; integrate PR #72 before release qualification'

# Write evidence OUTSIDE the checkout, so it cannot silently alter the tested SHA.
base=${SPOOL_EXTERNAL_EVIDENCE_ROOT:-"${TMPDIR:-/tmp}"}
[[ -d "$base" ]] || fail "evidence root does not exist: $base"
base=$(realpath "$base")
case "$base" in "$repo"|"$repo"/*) fail "evidence root must be outside the checkout";; esac
evidence=$(mktemp -d "$base/spool-external-${sha:0:12}-XXXXXXXX")
printf 'SHA=%s\nUTC_STARTED=%s\nQUALIFICATION_CLAIM=NOT_QUALIFIED\n' "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$evidence/manifest.txt"
printf 'EVIDENCE_DIR=%s\n' "$evidence"
export SPOOL_COMMIT_SHA="$sha"

# Fail-closed: do not skip failed commands and never produce a green status.
run_gate() {
  local name=$1
  shift
  printf 'BEGIN %s\n' "$name"
  printf 'RUN %s\n' "$name" >> "$evidence/manifest.txt"
  local result=0
  "$@" > "$evidence/$name.log" 2>&1 || result=$?
  printf 'EXIT_%s=%s\n' "$name" "$result" >> "$evidence/manifest.txt"
  if (( result != 0 )); then
    printf 'GATE_FAILED=%s\nQUALIFICATION_CLAIM=NOT_QUALIFIED\n' "$name" >> "$evidence/manifest.txt"
    (cd "$evidence" && sha256sum -- *.log manifest.txt > sha256sums.txt)
    printf 'FAIL %s (exit %s); see %s/%s.log\n' "$name" "$result" "$evidence" "$name" >&2
    exit 1
  fi
  printf 'PASS %s\n' "$name"
}

run_gate npm-install npm ci
run_gate dependency-audit npm audit --omit=dev --audit-level=high
run_gate unit-integration npm test
run_gate model-check npm run check:model
run_gate static-check node scripts/static-check.js
run_gate build npm run build
# Real Chromium checks the built site via SPA rewrites; screenshot stays OUTSIDE
# the immutable checkout and is included in the evidence checksums.
run_gate browser-smoke bash scripts/qualify/browser-smoke-direct.sh "$evidence/browser-smoke.png"
run_gate package npm run pack:verify
run_gate release-gate node scripts/release-gate.js

# Run the entire real PostgreSQL conformance corpus, not a mocked subset.
shopt -s nullglob
pg_tests=(tests/conformance/postgres*.test.js)
redteam_tests=(tests/industrial-postgres-*.test.js tests/industrial-redteam.test.js)
(( ${#pg_tests[@]} > 0 )) || fail 'no PostgreSQL conformance tests found'
(( ${#redteam_tests[@]} >= 2 )) || fail 'no complete PostgreSQL red-team tests found'
run_gate postgres-conformance node --test --test-concurrency=1 "${pg_tests[@]}"
run_gate postgres-redteam node --test --test-concurrency=1 "${redteam_tests[@]}"
run_gate postgres-materialization node scripts/qualify-postgres-materialization.js
run_gate postgres-qualification node scripts/qualify/industrial-postgres.js --profile CI --output "$evidence/postgres"
run_gate evidence-verification node scripts/qualify/verify-evidence.js "$evidence/postgres"

# CodeQL and independent platform/security gates remain separately REQUIRED.
# A missing CodeQL CLI is NOT treated as an optional success.
if ! command -v codeql >/dev/null 2>&1; then
  printf 'GATE_FAILED=codeql-cli-missing\nQUALIFICATION_CLAIM=NOT_QUALIFIED\n' >> "$evidence/manifest.txt"
  (cd "$evidence" && sha256sum -- *.log manifest.txt > sha256sums.txt)
  fail "CodeQL CLI is mandatory; evidence is incomplete at $evidence"
fi
run_gate codeql-db codeql database create "$evidence/codeql-db" --language=javascript-typescript --source-root="$repo" --overwrite
run_gate codeql-analysis codeql database analyze "$evidence/codeql-db" codeql/javascript-queries:codeql-suites/javascript-security-and-quality.qls --format=sarif-latest --output="$evidence/codeql.sarif"
run_gate codeql-findings node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const sarif = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(sarif.runs) || sarif.runs.length === 0) process.exit(2);
  const findings = sarif.runs.flatMap(run => run.results ?? []);
  if (findings.length !== 0) { console.error(`${findings.length} CodeQL findings; refusing a clean gate`); process.exit(1); }
' "$evidence/codeql.sarif"

# Qualification evidence must still be bound to the same clean tree after
# all tools have run; a tool that mutates source invalidates the candidate.
run_gate source-integrity bash -c '[[ $(git rev-parse HEAD) == "$SPOOL_COMMIT_SHA" && -z $(git status --porcelain --untracked-files=all) ]]'

# Only this exact local Linux/PG configuration ran here. Windows/macOS, true
# kill/failover, scale and enterprise IAM must be separately qualified.
printf 'UTC_FINISHED=%s\nLOCAL_LINUX_PG_GATES=PASS\nQUALIFICATION_CLAIM=DEVELOPMENT_EVIDENCE_ONLY\nRELEASE_AUTHORIZED=NO\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$evidence/manifest.txt"
(cd "$evidence" && sha256sum -- *.log manifest.txt codeql.sarif browser-smoke.png > sha256sums.txt)
printf 'LOCAL DEVELOPMENT GATES PASS. NOT A PRODUCTION/INDUSTRIAL CERTIFICATE. Evidence: %s\n' "$evidence"
