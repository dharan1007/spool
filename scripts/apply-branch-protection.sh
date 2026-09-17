#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${GITHUB_REPOSITORY:-dharan1007/spool}"
TARGET_BRANCH="${SPOOL_PROTECTED_BRANCH:-main}"

RULESET_ID="$(gh api -X POST "/repos/$REPOSITORY/rulesets" \
  -f name="spool-protected-$TARGET_BRANCH" \
  -f enforcement="active" \
  -f target="branch" \
  -F conditions='{"ref_name":{"include":["'$TARGET_BRANCH'"],"exclude":[]}}' \
  -f rules='[
    {"type":"required_signatures"},
    {"type":"requires_linear_history"},
    {"type":"non_fast_forward"},
    {"type":"deletion"},
    {"type":"pull_request","parameters":{"required_approving_review_count":1,"require_code_owner_review":false,"required_review_thread_resolution":true,"dismiss_stale_reviews_on_push":false,"require_last_push_approval":false,"required_deployments":[],"require_up_to_date_branch":true}}
  ]' \
  --jq '.id')"

echo "ruleset $RULESET_ID applied to $TARGET_BRANCH in $REPOSITORY"
gh api "/repos/$REPOSITORY/rulesets/$RULESET_ID" --jq '{id, name, enforcement, target}'