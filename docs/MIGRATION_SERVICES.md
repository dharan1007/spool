# SPOOL Migration Services

SPOOL's initial commercial model is outcome-based migration work, not a seat-gated "Pro" tier. The open-source repository remains MIT licensed; commercial engagements cover scoped assessment, migration preparation/execution, custom implementation and support.

## 1. Migration Preflight

**Use when:** a team is about to import or migrate data and wants to know what will break before touching the target.

Typical deliverables:

- source profile and inferred field evidence;
- deterministic target-schema recommendation;
- ambiguity and violation categories;
- incompatible date/number/boolean/header findings;
- target-readiness risks;
- sanitized migration-readiness report;
- recommended next migration scope.

This service does not require SPOOL to mutate a production database.

## 2. Import-Ready Dataset

**Use when:** a CSV/export must be made safe for another system's importer.

Typical deliverables:

- normalized output CSV/JSON;
- declared target schema;
- transformation plan identity;
- explicit rejected/invalid rows or grouped violation report;
- row-accounting summary;
- reproducible SPOOL release/commands used for preparation.

For sensitive datasets, prefer execution on the customer's environment and share only the resulting evidence/artifacts the customer approves.

## 3. Migration Rescue

**Use when:** an import is already failing or producing inconsistent outcomes because of mixed formats, invalid rows, schema mismatch or prior partial attempts.

The engagement starts with a non-destructive preflight. SPOOL does not respond to uncertain prior writes by blindly replaying them; the target state must be understood before mutation begins.

## 4. Verified CSV → SQLite Migration

**Current production connector scope:** filesystem UTF-8 CSV into an existing ordinary SQLite table using deterministic mapping and **insert** strategy.

The Gate-B execution path includes:

- source content snapshot binding;
- source/target allow-root containment;
- live SQLite target-contract introspection/fingerprint;
- target-write approval bound to the exact plan, source snapshot and live target contract;
- durable lease + fencing;
- atomic row + per-batch reconciliation ledger transactions;
- commit-before-checkpoint recovery semantics;
- exact replay/idempotency conflict detection;
- fail-closed target schema drift detection inside the write transaction;
- row-accounting and ledger verification;
- canonical receipt carrying release/plan/source/target/batch evidence.

The current Gate-B connector deliberately rejects:

- PostgreSQL/MySQL or arbitrary remote databases;
- truncate/replace/delete/upsert strategies;
- SQLite targets with triggers;
- virtual tables;
- target contracts incompatible with the declared SPOOL schema;
- source/target paths outside configured allow-roots;
- plans without `target_write` approval;
- changed sources or changed targets after approval;
- conflicting or indeterminate reconciliation states.

Unsupported capability is a scoped engineering project, not a reason to bypass these controls.

## Commercial intake

Use the repository's **Migration Assessment** issue form for initial non-sensitive qualification. It is a public issue: provide only system category, approximate size, failure mode, urgency and sensitivity classification. Never attach real rows, database dumps, secrets or customer records.

If the case proceeds, establish a private contact channel and written statement of work before sensitive information is exchanged.

## Statement of work minimum fields

Every paid migration should define:

- source system/file(s);
- target system/table(s);
- approximate size/rows;
- declared target contract;
- allowed write strategy/effects;
- data sensitivity;
- environment/credential ownership;
- backup and restore responsibility;
- SPOOL release/runtime to be used;
- verification/acceptance criteria;
- deliverables;
- exclusions/known exceptions;
- deadline;
- fee/payment milestones;
- private support/contact mechanism;
- any required data-processing/security terms.

## Acceptance evidence

A database migration is not accepted merely because the process exits with code 0. For current SQLite work, acceptance should include the configured verification result and SPOOL receipt. The receipt binds the release commit, plan ID, source snapshot, target identity, live target-contract ID, batch IDs, row counts, violation summary and timestamps.

A SPOOL receipt is technical provenance evidence, not a legal/regulatory certification.

## Pricing

Pricing is quoted by migration scope and risk rather than by user seat. Useful commercial units include assessment complexity, dataset size, migration outcome, custom connector work and support obligations. Repository documentation intentionally does not promise a universal price or SLA that has not been agreed for a specific engagement.
