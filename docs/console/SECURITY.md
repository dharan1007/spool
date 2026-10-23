# SPOOL Console security

## Threat model deltas (relative to docs/THREAT_MODEL.md of the engine)

The Console adds three attacker surfaces the engine itself does not have:

1. **Renderer compromise** — arbitrary web code running next to user input.
2. **Native dialog trickery** — pointing the privileged side at attacker files.
3. **Local artifact mutation** — tampering with evidence exports or metadata.

The mitigations below are all fail-closed; none rely on the renderer behaving.

## Renderer hardening

- Sandbox enabled, `nodeIntegration: false`, `contextIsolation: true`
  (`electron/main.js`).
- `setWindowOpenHandler` denies every new window; `will-navigate` denies
  navigation away from the bundled renderer; `will-attach-webview` denied.
- CSP injected over every response:
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
  — the renderer cannot talk to the network at all.
- Permission requests and permission checks are refused by default.
- The preload bridge (`preload/preload.cjs`) exposes exactly one function,
  `spool.invoke(op, payload)`, which forwards to a single IPC handle. There is
  no event channel that a compromised renderer could push through.

## Request validation

`service/contracts.js` declares every privileged operation with zod
`.strict()` schemas. Validation happens in the main process before dispatch —
unknown operations, undeclared extra fields, oversized strings and non-enum
types all fail with `CONSOLE_VALIDATION_FAILED` and are logged to the activity
trail. Operation names are bounded to 128 characters in the preload as a
first filter.

## Approval signing key

- Generated at first launch (32 random bytes) inside the main process only.
- Encrypted with `safeStorage` (Windows DPAPI) before it touches disk,
  mode 0600, together with a marker JSON that pairs `schema` + `provider`.
- Never returned over IPC — not even encrypted; the renderer only ever learns
  `APPROVAL_KEY_UNAVAILABLE` / health booleans via `security.keyHealth`.
- **No plaintext fallback**: if `safeStorage` is unavailable, or a stored blob
  is not OS-encrypted, or decryption fails, boot fails closed with
  `APPROVAL_KEY_UNAVAILABLE`.
- A bin without a marker predates the pairing scheme and is treated as an
  untrusted artifact: it is deleted and regenerated once.
- Known property (verified during packaging): safeStorage blobs are bound to
  the app's own user-data context. Keys do not transfer across dev/packaged
  contexts or across machines; `failed to decrypt` then fails closed and the
  user must create fresh approvals — stale approvals remain unusable, which is
  the required behaviour after a key change.

## Path and file safety

- Source CSV and target SQLite paths arrive via OS dialogs or typed paths; the
  service resolves them through the engine's path policy (`createPathPolicy`)
  with per-migration roots, so containment is enforced by the engine, not by
  the Console.
- Evidence/diagnostics export directories are user-selected; exports only ever
  write into the chosen directory.
- The source fingerprint (`sha256:`) recorded at inspection is re-checked
  before plan/dry-run/approve/execute (`SOURCE_UNCHANGED_CHECK_FAILED`).

## Engine-coupled guarantees

The Console cannot weaken the engine guarantees because it cannot reach them:
mutation flows exclusively through `SpoolCommandService`, whose durable state
machine, approval binding, leases, checkpoints and receipts are unchanged.
The Console adds `MIGRATION_ALREADY_RUNNING` (synchronous in-process guard) on
top so a double click cannot start two runs.

## Evidence integrity

Evidence bundles are JSON with a sha256 manifest over exact bytes. Verification
recomputes the hash and fails closed (`EVIDENCE_BUNDLE_INVALID`) on any
modification. Test coverage: `tests/full-journey.test.js` tampers the bundle
and asserts rejection.

## What is intentionally NOT available (fail-closed)

PostgreSQL/MySQL/MSSQL targets, CDC, repair, cutover, content-exact
verification and multi-GB sources are refused by the production policy even if
an attacker crafts a request directly (the engine layer enforces it
independently of the Console).
