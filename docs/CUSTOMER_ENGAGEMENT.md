# SPOOL Customer Engagement Workflow

This document defines the operational workflow for paid SPOOL migration work delivered by **Dharan Tej Reddy Poduvu as an individual service provider**. It is an operating checklist, not legal or tax advice and not a substitute for a lawyer or accountant where one is required.

## Zero-cost operating model

SPOOL does not require a hosted customer-data plane, paid checkout, company entity, CRM, or payment gateway for the current service model. Public GitHub intake is **metadata-only**. Customer datasets, database files, credentials, private URLs, personal data, payment details, and production access instructions stay out of public issues.

The working flow is:

```text
lead
→ metadata-only assessment
→ private qualification
→ written quote/scope
→ payment terms agreed privately
→ written authorization for target mutation
→ backup/restore responsibility confirmed
→ customer-local execution
→ verification + receipt
→ delivery manifest
→ written customer acceptance
→ optional anonymized case-study consent
```

## 1. Public qualification

The public Migration Assessment may contain only enough metadata to understand the problem:

- source format/system;
- target format/system;
- approximate rows/file size;
- current failure or desired outcome;
- deadline;
- whether sensitive or regulated information exists;
- whether the customer controls the target and has a backup/restore path.

Never request or accept raw production rows, database dumps, credentials, API tokens, private URLs, or confidential documents in a public GitHub issue.

## 2. Move real details to a private channel

Before inspecting real data, move the engagement to a private customer-approved channel. Share payment instructions only **privately**. Do not publish banking, identity-document, or personal-address details in the repository or issue tracker.

Record internally:

- customer/contact;
- quote ID;
- scope/version;
- service selected;
- price and payment terms;
- data-handling method;
- authorization status;
- delivery date;
- acceptance status;
- SPOOL receipt/reference.

## 3. Quote before work

Use `docs/INVOICE_QUOTE_TEMPLATE.md`. Define:

- exact source and target scope;
- supported/unsupported operations;
- deliverables;
- acceptance criteria;
- price;
- payment schedule;
- customer responsibilities;
- data-handling boundary;
- backup/restore responsibility;
- expiration of the quote.

For small bounded preflight work, full payment before work may be appropriate. For larger bounded work, a deposit plus balance on acceptance can be agreed privately. These are commercial choices, not platform-enforced billing rules.

## 4. Obtain written authorization

Before any target mutation, obtain the customer's written authorization using `docs/AUTHORIZATION_TEMPLATE.md` or an equivalent signed/written scope. It must identify the target, the permitted operation, the approved source, the allowed time/scope, and who is responsible for backup/restore.

No authorization means no production target write.

## 5. Execute locally/customer-side

Prefer customer-controlled execution:

- customer machine;
- customer-controlled VM/workstation;
- agreed private remote session;
- a scoped local copy where appropriate and authorized.

For Gate B, use the documented `inspect → plan → dry-run → approve → run → verify → receipt` lifecycle. Keep the `target_write` approval bound to the exact plan, source snapshot, target contract, principal, effects, and expiry.

## 6. Deliver evidence, not only files

Every paid delivery should include a **delivery manifest** identifying what was produced. Depending on service scope this can include:

- cleaned/import-ready dataset;
- rejected-row or violation report;
- mapping/schema notes;
- target verification result;
- SPOOL receipt;
- exact release/version used;
- known exclusions or unresolved records;
- customer-side next step.

Use `docs/DELIVERY_ACCEPTANCE_TEMPLATE.md` for final handoff.

## 7. Obtain written acceptance

Ask the customer to confirm the agreed acceptance criteria, not merely say "looks good." For example:

- target import completed;
- expected row accounting reconciled;
- agreed rejected records are explicitly listed;
- deliverables were received;
- no agreed blocker remains.

If acceptance fails, record the failed criterion and treat remediation as in-scope only when the quote says it is.

## 8. Case studies are optional

A customer does not need to grant marketing permission to receive service. Use `docs/CASE_STUDY_CONSENT_TEMPLATE.md` only if the customer voluntarily permits an anonymized or named case study. Do not expose customer identity or data without explicit consent.

## 9. Cash-flow discipline

Maintain a private ledger containing quote/invoice reference, amount quoted, amount received, payment date/reference, delivery date, balance, and acceptance. Do not commit this ledger to GitHub.

## Current product boundary

Current evidence-backed production execution is UTF-8 filesystem CSV → existing ordinary SQLite table, `insert` mode only. Browser Studio is local-first and capped at 50 MiB. Unsupported connectors or destructive operations must not be sold as already production-supported.
