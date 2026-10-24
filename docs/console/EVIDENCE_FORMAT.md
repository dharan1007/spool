# Evidence format

## Bundle layout

```
<directory>/
  manifest.json
  migration.json       design record (source/target/paths/revisions)
  plan.json            engine plan snapshot (canonical input + planId)
  dry-run.json         accumulator summary + plan binding
  approval.json        signed approval record (bound ids, expiry, nonce-consumed state)
  status.json          engine status summary at export time
  activity.json        Console activity trail for the migration
  source-profile.json  inspected source record incl. sha256 fingerprint
```

## manifest.json

```json
{
  "schemaVersion": 1,
  "kind": "spool-console-evidence-bundle",
  "createdAt": "2026-10-23T…",
  "bundleVersion": 1,
  "files": [
    { "path": "migration.json", "sha256": "…", "bytes": 1234 },
    …
  ],
  "aggregateSha256": "…"
}
```

- Hashes are over **exact file bytes** (utf8, LF newline discipline enforced by
  the serializer).
- `aggregateSha256` hashes the canonical manifest body excluding itself so the
  aggregate is stable.
- Verification (`evidence.verify`) re-reads the directory, recomputes every
  hash and the aggregate, and compares. Any drift fails with
  `EVIDENCE_BUNDLE_INVALID` including the offending path.

## Semantic guarantees

- The bundle is a **snapshot**, not a live view; regenerating after further
  steps yields a new bundle with new hashes.
- Tamper-evidence: modifying any member (or its newline style) breaks its
  hash — covered by the full-journey test that mutates `lastStatus` and
  expects rejection.
- The bundle does not include the signing key or any secret; approvals are
  stored bound to their ids. Errors carrying secret-looking fields never enter
  the bundle because the REDACTED cleaner in `errors.js` applies to everything
  we persist.
