# SPOOL Migration Services

Commercial migration work is currently offered personally by **Dharan Tej Reddy Poduvu**, an individual solo builder/service provider. SPOOL is not currently represented as an incorporated company. The open-source repository remains MIT licensed; paid work covers scoped outcomes, execution, support, and implementation.

## Zero-cost delivery model

The first customers do not require a paid SaaS stack. Qualification happens through the public metadata-only Migration Assessment form, then the engagement moves to a private contact channel. Customer data should remain on the customer/local machine wherever practical, and SPOOL is executed locally.

No paid authentication, hosted database, analytics, CRM, checkout, or payment gateway is required to deliver the current services.

## 1. Migration Preflight

**Use when:** a customer is about to import or migrate data and wants to know what will break before touching the target.

Deliverables can include:

- source profile and inferred field evidence;
- deterministic target-schema recommendation;
- ambiguity/violation categories;
- incompatible date/number/boolean/header findings;
- target-readiness risks;
- sanitized readiness report;
- recommended next scope.

Suggested first-customer test price: **₹2,500–₹7,500** for a bounded CSV case.

## 2. Import-Ready Dataset

**Use when:** a CSV/export must be made safe for another system's importer.

Deliverables can include:

- normalized output CSV/JSON;
- declared target schema;
- transformation plan identity;
- explicit rejected/invalid rows or grouped violation report;
- row-accounting summary;
- reproducible SPOOL release/commands used.

Suggested first-customer test price: **₹5,000–₹15,000** for a bounded CSV case.

For sensitive datasets, prefer execution on the customer's environment and share only approved evidence/artifacts.

## 3. Migration Rescue

**Use when:** an import is already failing or producing inconsistent outcomes because of mixed formats, invalid rows, schema mismatch, or prior partial attempts.

The engagement starts with a non-destructive preflight. SPOOL does not respond to uncertain prior writes by blindly replaying them.

Suggested first-customer test price: **₹7,500–₹25,000+** depending on urgency and complexity.

## 4. Verified CSV -> SQLite Migration

**Current production connector scope:** filesystem UTF-8 CSV into an existing ordinary SQLite table using deterministic mapping and `insert` strategy.

The Gate-B execution path includes:

- source content snapshot binding;
- source/target allow-root containment;
- live SQLite target-contract introspection/fingerprint;
- target-write approval bound to the exact plan, source snapshot, and live target contract;
- durable lease + fencing;
- atomic migrated rows + per-batch reconciliation ledger;
- commit-before-checkpoint recovery;
- exact replay/idempotency conflict detection;
- fail-closed target-schema drift detection inside the write transaction;
- row-accounting and ledger verification;
- canonical receipt carrying release/plan/source/target/batch evidence.

Suggested first-customer test price: **₹10,000–₹30,000+** for a bounded supported migration.

The current connector deliberately rejects PostgreSQL/MySQL, arbitrary remote DBs, truncate/replace/delete/upsert, SQLite targets with triggers, virtual tables, incompatible target contracts, paths outside allow-roots, missing target-write approval, changed sources/targets after approval, and conflicting/indeterminate reconciliation.

Unsupported capability is a separate engineering project; do not bypass safety controls to win a sale.

## Commercial intake

Use the repository's **Migration Assessment** issue form for initial non-sensitive qualification. It is public: provide only system category, approximate size, failure mode, urgency, and sensitivity classification. Never attach real rows, database dumps, secrets, private URLs, or customer records.

If the case proceeds, establish a private contact channel and an accepted written quote/order before sensitive information is exchanged.

## Minimum quote/order fields

Every paid migration should define:

- provider: Dharan Tej Reddy Poduvu, individual service provider;
- customer;
- source and target;
- approximate size/rows;
- desired outcome;
- supported write strategy/effects;
- data sensitivity;
- backup/restore responsibility;
- SPOOL release/commit;
- verification/acceptance criteria;
- deliverables and exclusions;
- deadline;
- fee/payment schedule;
- private contact/payment method;
- tax/GST treatment appropriate to the provider's actual registration status.

Use [`INVOICE_QUOTE_TEMPLATE.md`](INVOICE_QUOTE_TEMPLATE.md) as the operational starting point.

## Acceptance evidence

A database migration is not accepted merely because the process exits successfully. Current SQLite acceptance should include configured verification and the SPOOL receipt. The receipt binds release commit, plan ID, source snapshot, target identity, target-contract ID, batch IDs, counts, violations, and timestamps.

A SPOOL receipt is technical provenance evidence, not legal/regulatory certification.

## Pricing policy

Pricing is per migration outcome/risk, not per seat. The amounts above are launch hypotheses intended to obtain the first paying customers and evidence. Quote after qualification; do not promise fixed scope where the source/target state is unknown.

The fastest revenue path is to sell the customer's immediate problem, not a subscription:

- "I will make this failing CSV import-ready."
- "I will identify exactly which rows/types will break this migration before you touch production."
- "I will run the supported CSV -> SQLite migration locally and deliver verification evidence."
