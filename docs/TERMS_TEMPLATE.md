# SPOOL Commercial Terms Template

> **Status: solo-builder commercial template for review, not legal advice.** SPOOL commercial services are currently offered personally by **Dharan Tej Reddy Poduvu**, an individual solo builder/service provider. SPOOL is not represented here as an incorporated company, LLP, or separate legal entity. Jurisdiction-specific tax, liability, privacy, and contracting requirements still need to be checked for the actual customer engagement.

## 1. Provider and customer

Provider: **Dharan Tej Reddy Poduvu, individual service provider / solo builder**.

The applicable quote, order, or statement of work (the **Order**) identifies the customer, effective date, scope, fees, private contact details, and any customer-specific terms. If there is a conflict, the accepted Order controls for that engagement.

Private address, PAN, Aadhaar, bank details, UPI details, and other personal identifiers must not be published in this repository. Add only legally required billing information privately for the specific transaction.

## 2. Service scope

SPOOL software is available under the MIT License. Paid work covers professional services such as Migration Preflight, Import-Ready Dataset preparation, Migration Rescue, Verified CSV -> SQLite migration, support, or separately scoped implementation.

The current production connector claim is limited to the capability matrix in the README. Unsupported connectors or destructive strategies are not implicitly included.

## 3. Customer authorization and responsibilities

The customer represents that it has authority to provide/process the data and systems included in the Order. Before production mutation, the customer must identify the target, confirm backup/restore readiness, and approve the exact migration plan/effects through the agreed mechanism.

The customer remains responsible for lawful data use, source/target credentials, environment access, backups, and business-specific validation not included in SPOOL's configured verification policy.

## 4. Data handling

The default commercial architecture is local-first. Browser Studio rows remain in the browser data plane, and current Gate-B CSV-to-SQLite execution runs in the customer's/local environment. Public GitHub issues are metadata-only and must never contain confidential rows, credentials, dumps, or private URLs.

If an engagement requires access to real customer data, the Order must state how it is transferred, accessed, retained, and deleted. Prefer customer-local execution whenever possible.

## 5. Migration safety and acceptance

The Order should identify source, target, target contract, permitted write strategy, row-accounting rules, effects, backup responsibility, acceptance tests, deliverables, and exclusions.

A SPOOL `VERIFIED` result means the configured technical checks passed for the identified release/plan/source/target evidence. It is not a legal, regulatory, accounting, or compliance certification.

## 6. Fees, payment, and tax

Fees, currency, due dates, refund/cancellation rules, and payment schedule are stated in the accepted Order or quote.

For early solo-builder engagements, payment may be made manually through a mutually agreed private payment method; no paid checkout or payment gateway is required.

**The provider must not charge or label an amount as GST unless actually registered and GST is applicable to the transaction.** If GST registration is not in force, do not issue a GST tax invoice or display a GSTIN that does not exist. Maintain private records of quotes, invoices/receipts, payments, refunds, and delivered services for tax/accounting purposes.

## 7. Open-source software

Repository code remains governed by the MIT License. Commercial fees are for scoped services, support, implementation, or other separately agreed outcomes, not for revoking rights already granted under MIT.

## 8. Support

Public repository support has no SLA. Any paid support window or response target must be expressly stated in the Order. `docs/COMMERCIAL_SUPPORT.md` defines the operating severity model.

## 9. Security

Both parties should use reasonable safeguards for credentials and confidential information. Customers must not publish production datasets or exploit payloads in public repository channels. Security reports follow `SECURITY.md`.

## 10. Confidentiality

Do not assume this public template alone creates confidentiality obligations. If confidential information must be exchanged, use a private channel and include appropriate confidentiality terms in the accepted Order or a separate agreement.

## 11. Warranties and disclaimers

Do not promise uninterrupted or error-free migration execution. The MIT-licensed software remains subject to the MIT disclaimer. Any paid-service remediation commitment must be one the provider can actually support and should be stated in the Order.

## 12. Liability

Because the provider is currently an individual/sole operator rather than a separate limited-liability company, business obligations may attach personally. Do not invent a liability cap in this repository. For material or high-risk engagements, negotiate written limits/exclusions appropriate to the customer, data, and applicable law before proceeding.

## 13. Suspension and unsafe conditions

Execution may stop when source identity changes, target contract changes, approval becomes invalid, fencing is stale, reconciliation is conflicting/indeterminate, storage/target writes fail, or continuing would risk integrity. A safe stop is not permission to bypass the failed control.

## 14. Termination and transition

The Order should state termination rights, work-in-progress handling, payment due on termination, return/deletion of customer materials, and transition obligations.

## 15. Governing law and disputes

For an actual paid engagement, add governing-law, venue/dispute, notice, and identity details appropriate to the provider and customer. For material contracts or cross-border/high-risk work, obtain qualified legal/tax review before signing.

## Minimum pre-engagement checklist

- provider shown as Dharan Tej Reddy Poduvu, individual service provider;
- customer identified;
- scope/deliverables/exclusions written;
- fee/payment schedule written;
- tax/GST status checked for the actual transaction;
- private contact/payment details exchanged privately;
- data-handling method agreed;
- backup/restore responsibility agreed for mutation;
- acceptance criteria agreed;
- liability/confidentiality terms strengthened if the engagement risk requires it.
