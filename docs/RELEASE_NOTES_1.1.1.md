# SPOOL v1.1.1

v1.1.1 is a focused Local Runner reliability patch on top of the v1.1.0 bounded-memory release.

## Fixed

Long-running streamed CSV → SQLite migrations now renew their same-owner execution lease immediately before each target batch mutation. This prevents a healthy migration from losing its five-minute execution authority mid-run while preserving the existing monotonic fencing contract: another active owner is still rejected, and stale fencing tokens still fail inside the SQLite write transaction.

## Verification

The defect was reproduced first with a deterministic regression that advanced the execution clock across one-row batches and failed with `LEASE_EXPIRED`. The fix then passed the full release gate, packed/global CLI verification, built-artifact Chrome smoke, SQLite conformance on Ubuntu, macOS and Windows, and CodeQL before merge to `main`.

The production scope is otherwise unchanged from v1.1.0: Browser Studio remains capped at 50 MiB; the customer-local Local Runner uses bounded-memory streaming with a 256 MiB default source ceiling and supports UTF-8 filesystem CSV → existing ordinary SQLite table with insert-only writes, snapshot binding, approval, fencing, reconciliation, verification and commit-bound receipts.
