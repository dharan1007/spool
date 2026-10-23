# Approval model

Approval is the point where a human endorses **exactly one** migration shape.
The Console implements it as a signature over the engine's canonical approval
record; nothing else authorizes execution.

## What is bound

When you approve, the engine creates a bound approval (`approve()` on
`SpoolCommandService`) covering:

- the exact canonical plan (`planId`, sha256 of the canonical plan document)
- the source snapshot (`sourceSnapshotId`) pinned at inspection/plan time
- the target contract (`targetContractId` of the live SQLite schema)
- the request semantic id (canonical plan input identity)
- an expiry timestamp and a single-use nonce

The Console defaults the validity window from settings
(`approvalMinutes`, default 60); the request may override it for longer runs.

## Keys

- The signing key is generated per machine on first launch and stored
  DPAPI-encrypted (`electron/key-store.js`). It never leaves the main process
  and is never returned through IPC.
- Approvals are therefore **machine-local**: they verify on the machine and
  profile where they were created. Copying state to another machine fails the
  verification on purpose.

## Expiry and single use

- An expired approval fails with `APPROVAL_EXPIRED`; the fix is a fresh
  approval (dry-run first if the source changed meanwhile).
- Nonces are single-use: consuming the approval during `execute()` invalidates
  it. Retrying after a crash re-uses the durable checkpoints through a new
  approval, never the consumed one.

## Order of operations

create → plan → dry-run → approve → execute.

The service layer enforces this: dry-run requires the recorded plan id to
match (else `MIGRATION_STEP_OUT_OF_ORDER`), approve recomputes the plan and
requires the recorded **plan and dry-run** to be bound to that same id, and
execute requires the approval to still verify. The source fingerprint is
re-checked in every step (`SOURCE_UNCHANGED_CHECK_FAILED`).

## Who may approve

The principal is `console:user`: the single local operator. The Console has no
server-side authority model because the local application cannot observe other
operators; the security property instead comes from key custody (DPAPI) and
approval binding. A recipe/draft import never grants approval — imported
recipes land in `REVIEW_REQUIRED` and still require the full pipeline.
