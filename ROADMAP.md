# SPOOL Roadmap

SPOOL's roadmap is ordered by **migration correctness and recoverability**, not by feature count. Items move to complete only when the checked-in implementation and release gates prove the claimed behavior.

## Now — harden the deterministic nucleus

- Expand the public migration-case corpus: locale numbers, malformed dates, mixed booleans, duplicate/unsafe headers, formula injection, partial rows and schema drift.
- Keep deterministic benchmark generation reproducible and separate engine throughput from agent-quality claims.
- Strengthen browser smoke coverage for deep links, Worker boot, IndexedDB recovery and export behavior.
- Improve grouped violation diagnostics without exposing unbounded row data to an agent.
- Keep the local-first 50 MB browser boundary explicit until streaming/OPFS behavior is implemented and measured.

## Next — connector-native durable migrations

The next major capability class is **real destination execution with truthful crash reconciliation**, not a collection of thin connector wrappers.

Priorities:

1. SQLite destination adapter with a durable per-batch idempotency/reconciliation ledger committed in the same target transaction as migrated rows.
2. Deterministic `reconcileTargetCommit(batchIdentity)` semantics so a restart can prove whether the exact batch committed before a local checkpoint was persisted.
3. Commit-before-checkpoint fault injection and recovery tests.
4. Source snapshot binding so a resumed run cannot silently continue against changed input.
5. Lease/fencing semantics for long-running target mutations where multiple workers/processes could race.
6. Credential isolation and capability declarations that act as enforceable security boundaries rather than documentation.
7. Filesystem target hardening against symlink/junction escapes where local paths are introduced.

Only after one connector demonstrates the full safety contract should the same adapter boundary expand to additional destinations such as PostgreSQL.

## Later — scale and ecosystem

- Streaming/OPFS ingestion for files beyond the current in-memory browser boundary, with explicit quota/error behavior.
- More destination adapters that satisfy the same reconciliation/idempotency contract.
- Importable migration-case fixtures and a public "migration torture set" for fair regression testing.
- Stable reusable core packages once API boundaries stop changing quickly.
- Additional agent/client integrations where the protocol boundary is standardized and testable.
- Controlled flat-catalog-vs-temporal-tool evaluations if making claims about agent completion rate or context efficiency.

## Explicit non-goals

SPOOL will not trade its core guarantees for growth metrics. The project will not:

- execute arbitrary model-generated code against migration data,
- call an adapter "production-ready" because it can connect once,
- claim universal LLM success improvements from serialized-schema measurements,
- silently coerce invalid values to inflate success rates,
- fabricate benchmark or deployment evidence.

## How roadmap work becomes real

Roadmap items should be represented by GitHub issues with acceptance criteria and tests. Significant architecture changes should start as a design/RFC discussion before implementation.

If you want to help, start with `good first issue` / `help wanted` tasks or contribute a privacy-safe migration fixture that exposes a real failure mode.