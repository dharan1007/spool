# SPOOL — Zero-Cost Solo Builder Launch

SPOOL can be sold today without a company, paid hosting, a SaaS backend, paid analytics, paid authentication, or a paid checkout.

## Provider

Commercial migration work is offered personally by **Dharan Tej Reddy Poduvu**, an individual solo builder. SPOOL is not currently represented as a company, LLP, private limited company, or other incorporated entity.

Do not publish a home address, personal ID number, bank account, Aadhaar, PAN, UPI ID, or other private identifier in this repository. Exchange billing/payment details privately after a customer is qualified.

## Zero-cost commercial architecture

```text
GitHub repository
  -> public documentation + release evidence
  -> Migration Assessment issue (metadata only)
  -> private contact channel chosen by customer/provider
  -> written scope + quote
  -> customer runs SPOOL locally
  -> migration output + violations + verification + receipt
  -> manual payment by mutually agreed bank/UPI/payment method
```

No customer dataset needs to be uploaded to a SPOOL-controlled server for the current supported services.

The Vercel browser deployment is a technical/open-source demo endpoint, not a paid SaaS data plane or payment endpoint. Paid work should be contracted and delivered as a local migration service until a commercially permitted hosted environment exists.

## What can be sold now

### Migration Preflight

Customer outcome: know what will fail before importing or migrating data.

Deliverables can include source profile, inferred schema, ambiguity/violation summary, target-readiness risks, and recommended migration plan.

Suggested first-customer test price: **₹2,500–₹7,500** for a bounded CSV case.

### Import-Ready Dataset

Customer outcome: receive a deterministic, normalized, validated dataset suitable for the declared importer/target contract.

Suggested first-customer test price: **₹5,000–₹15,000** for a bounded CSV case.

### Migration Rescue

Customer outcome: diagnose and repair a failed/dirty import where dates, numbers, booleans, headers, or target types are causing failures.

Suggested first-customer test price: **₹7,500–₹25,000+**, depending on urgency and complexity.

### Verified CSV -> SQLite Migration

Customer outcome: execute the supported Gate-B migration locally with source snapshot binding, target preflight, approval, atomic batch ledger, crash reconciliation, verification, and a receipt.

Suggested first-customer test price: **₹10,000–₹30,000+** for a bounded case.

These are launch pricing hypotheses, not promises or regulated tariffs. Quote each case after inspection.

## First-customer sales rule

Do not try to sell "SPOOL" as abstract infrastructure first. Sell a concrete outcome:

- "Your CSV import is failing — I will identify the invalid rows and give you an import-ready file."
- "Before you migrate this customer export, I will produce a deterministic preflight report showing schema and data-quality blockers."
- "I will migrate this bounded CSV into your SQLite target locally and deliver verification evidence and a receipt."

## Qualification checklist

A prospect is qualified when all of these are known:

- source format/system;
- target format/system;
- approximate rows/file size;
- actual failure or desired outcome;
- deadline;
- whether the data is sensitive;
- whether current SPOOL capability supports the requested target;
- who controls the target environment and backup.

Do not request raw sensitive rows in a public GitHub issue.

## Quote structure

Every quote should state:

- provider: Dharan Tej Reddy Poduvu, individual solo builder;
- customer name;
- exact scope;
- exact deliverables;
- exclusions;
- deadline;
- price;
- payment schedule;
- data-handling method;
- acceptance criteria;
- backup/restore responsibility for target mutation;
- SPOOL release/commit to be used.

For early work, prefer either 100% payment before delivery for very small jobs, or 50% before work and 50% on acceptance for larger bounded jobs. Do not begin risky target mutation without explicit written authorization and backup confirmation.

## Payment without a paid checkout

No payment gateway is required for the first customers. After qualification, provide payment instructions privately and use a mutually agreed method such as bank transfer or UPI for domestic customers. Do not place private banking details in the public repository.

Do not charge or label an amount as GST unless you are actually registered and legally required/entitled to do so. Keep a record of every quote, payment, invoice/receipt, customer, amount, date, and service delivered for tax/accounting purposes.

## Solo-builder legal/tax operating boundary

SPOOL's software remains MIT licensed. Paid fees are for personal professional services, migration execution, support, or custom implementation.

A sole proprietorship in India is not a separate incorporated legal person; the individual bears the obligations and liability of the business. Registration/compliance requirements depend on activity, turnover, location, customer geography, and tax status.

Before using GST language on invoices, verify whether GST registration is required for your actual turnover/supply pattern. If unregistered, do not issue a GST tax invoice or collect GST as though registered.

Free Udyam registration may be useful later as a proprietorship/MSME identity, but it is not treated by this repository as a prerequisite to obtaining the first customer.

## Zero-cash launch checklist

- [x] Open-source production code on GitHub
- [x] Real release gate and CodeQL
- [x] Cross-platform SQLite conformance
- [x] Built-browser smoke test
- [x] Public Migration Assessment form
- [x] Data-handling documentation
- [x] Support scope
- [x] Customer-style CRM migration fixture
- [x] Local CLI/spoold execution path
- [x] Solo-provider commercial positioning
- [x] Zero-cost service packaging
- [ ] First qualified prospect
- [ ] First written quote
- [ ] First paid engagement
- [ ] First customer acceptance/case study

The last four are sales outcomes, not missing product engineering.
