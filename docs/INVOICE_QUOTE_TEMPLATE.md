# SPOOL Solo Builder Quote / Invoice Template

Use this as an operational template for early paid engagements. It is not a GST tax-invoice template unless the provider is actually GST-registered and all legally required fields are added.

## Provider

**Dharan Tej Reddy Poduvu**  
Individual solo builder / service provider  
SPOOL — migration correctness infrastructure

Keep private address, PAN, Aadhaar, bank account, and payment identifiers off public GitHub. Add only the billing details actually required for the specific customer, and exchange them privately.

---

## Quote

Quote number: `SPOOL-Q-YYYY-NNN`  
Date: `YYYY-MM-DD`  
Valid until: `YYYY-MM-DD`

Customer: `[CUSTOMER NAME]`  
Customer contact: `[PRIVATE CONTACT]`

### Scope

`[Exact source, target, problem, and migration outcome]`

### Deliverables

- `[Deliverable 1]`
- `[Deliverable 2]`
- `[Deliverable 3]`

### Exclusions

- `[Anything explicitly not included]`

### Acceptance criteria

- `[Exact technical/customer acceptance condition]`
- `[Expected SPOOL verification/receipt where applicable]`

### Delivery

Target date: `[DATE]`

### Fee

Professional service fee: `₹[AMOUNT]`

Taxes: **Do not add GST unless the provider is registered and GST is applicable to the transaction.**

Payment schedule: `[100% upfront | 50% upfront / 50% on acceptance | custom]`

Payment instructions are provided privately after acceptance of this quote.

### Data handling

Default: customer-local execution where practical. Public GitHub issues are metadata-only and must not contain rows, credentials, database dumps, private URLs, or confidential records.

### Production mutation authorization

For any write to a customer-controlled target, the customer must confirm in writing:

- the exact target environment/table;
- authority to perform the migration;
- backup/restore readiness;
- approved write strategy/effects;
- acceptance criteria.

---

## Acceptance

Customer name: `[NAME]`  
Accepted scope/price: `[YES / SIGNATURE / EMAIL ACKNOWLEDGEMENT]`  
Date: `[DATE]`

---

# Payment Receipt / Invoice Record

Invoice/receipt number: `SPOOL-I-YYYY-NNN`  
Invoice date: `YYYY-MM-DD`  
Service period/delivery date: `[DATE]`

Provider: **Dharan Tej Reddy Poduvu — individual service provider**  
Customer: `[CUSTOMER NAME]`

Description: `[Migration Preflight / Import-Ready Dataset / Migration Rescue / Verified CSV -> SQLite / Custom Implementation]`

Amount: `₹[AMOUNT]`  
GST: `[Do not state or collect GST unless registered/applicable]`  
Total received/due: `₹[AMOUNT]`

Payment status: `[PAID / PARTIALLY PAID / DUE]`  
Payment reference: `[PRIVATE REFERENCE]`

Delivery evidence: `[SPOOL receipt ID / artifact / acceptance reference]`

## Records to keep privately

Keep a private ledger containing at minimum:

- quote/invoice number;
- customer;
- date;
- description;
- gross amount;
- payment date/method/reference;
- refunds if any;
- SPOOL migration/receipt reference;
- any tax-registration status relevant at the time.

Do not commit that private ledger to this public repository.
