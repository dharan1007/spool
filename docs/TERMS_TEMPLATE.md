# SPOOL Commercial Terms Template

> **Status: template for legal review.** This file is not legal advice and is not effective customer terms by itself. The provider's legal entity, jurisdiction, tax treatment, liability position and data-processing obligations must be completed and reviewed by qualified counsel before this template is published or signed.

## 1. Parties and order of precedence

The applicable order or statement of work (the **Order**) identifies the customer, the legal provider entity, effective date, scope, fees and any negotiated terms. If there is a conflict, the signed Order controls over this template for that engagement.

## 2. Service scope

SPOOL may be provided as open-source software, a hosted local-first browser application, local-runner tooling, and/or scoped migration services. The Order must identify the exact supported outcome. Features outside the documented capability matrix are not included unless expressly stated.

## 3. Customer authorization and responsibilities

The customer represents that it has authority to provide and process the data and systems included in the Order. Before any production mutation, the customer must identify the target environment, confirm required backups/restore procedures, and approve the exact migration plan/effects through the agreed authorization mechanism.

The customer is responsible for source and target credentials, lawful data use, environment access, independent backup/restore capability, and validating business-specific invariants that are not included in the agreed verification policy.

## 4. Data handling

The technical defaults are described in `docs/DATA_HANDLING.md`. Browser Studio rows are processed locally by SPOOL application code. Current Gate-B CSV-to-SQLite execution is local. Customer-specific requirements concerning personal data, retention, subprocessors, international transfer, breach notice or deletion must be documented in the Order and, where appropriate, a separate data-processing agreement.

Public GitHub issues must not contain confidential or regulated data.

## 5. Migration safety and acceptance

For production migration work, the Order should identify:

- source and target systems/files;
- target contract and write strategy;
- expected row-accounting rules;
- permitted effects;
- backup/rollback responsibilities;
- acceptance tests;
- delivery artifacts such as cleaned output, violations, verification results and migration receipt;
- any excluded records or known exceptions.

A SPOOL `VERIFIED` result means the configured technical checks passed for the identified release/plan/source/target evidence. It is not a regulatory certification, accounting audit, legal compliance opinion or proof of every customer-specific business rule.

## 6. Fees and payment

Fees, currency, taxes, payment schedule, refund/cancellation rules and expenses must be specified in the Order. The open-source MIT license does not include paid migration services, private support, custom implementation or any service-level commitment.

## 7. Open-source software

Repository code distributed under the MIT License remains governed by that license. Commercial fees are for scoped services, support, implementation, hosted/managed capabilities where applicable, or other separately agreed deliverables—not for revoking rights already granted by the MIT License.

## 8. Support

Public repository support has no SLA. Any commercial response targets, support window or incident handling commitment must be stated in the Order. `docs/COMMERCIAL_SUPPORT.md` describes the operating severity model.

## 9. Security

Each party must use reasonable safeguards for credentials and confidential data. Customers must not publish credentials, production datasets or exploit payloads in public repository channels. Security reports follow `SECURITY.md`.

## 10. Confidentiality

Any binding confidentiality obligations, exclusions, permitted recipients, compelled-disclosure process and survival period must be specified in a signed agreement. Do not rely on this repository template alone to establish confidentiality.

## 11. Warranties and disclaimers

The final agreement should state any service warranty and remediation commitment that the provider can actually operationally support. Open-source software remains subject to the MIT License disclaimer. Do not promise uninterrupted or error-free migration execution unless a negotiated agreement explicitly supports that promise.

## 12. Limitation of liability

The provider and customer must negotiate an appropriate liability allocation based on the engagement, data sensitivity and applicable law. Insert no artificial liability cap in this repository template; counsel should establish the cap, exclusions and treatment of confidentiality, security, IP, gross negligence/wilful misconduct and data loss for the actual legal entity and jurisdiction.

## 13. Suspension and unsafe conditions

SPOOL or the service operator may stop execution when source identity changes, target contract changes, approval becomes invalid, fencing is stale, reconciliation is conflicting/indeterminate, storage or target writes fail, or continuing would risk data integrity. Such a safe stop is not permission to bypass the failed control.

## 14. Termination and transition

The Order should state termination rights, work-in-progress handling, payment due on termination, delivery/return/deletion of customer materials and any transition assistance.

## 15. Governing law and disputes

**[COUNSEL TO COMPLETE]** Governing law, venue/arbitration, notices and dispute procedures must be chosen for the actual provider legal entity and customer relationship.

## Publication checklist

Before using these terms commercially, complete at minimum:

- legal provider name and registered address;
- governing law/dispute mechanism;
- tax/GST/export-of-services treatment;
- payment/cancellation/refund language;
- liability cap/exclusions;
- confidentiality agreement;
- privacy/data-processing obligations;
- authorized signatory and notice details;
- counsel approval for the intended customer geography.
