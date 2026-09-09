# SPOOL Privacy Notice Template

> **Status: solo-builder privacy template for review.** SPOOL commercial services are currently offered personally by **Dharan Tej Reddy Poduvu**, an individual solo builder/service provider. This is not legal advice and does not claim company/incorporation status.

## Provider

**Dharan Tej Reddy Poduvu**  
Individual service provider / solo builder

Do not publish a home address, PAN, Aadhaar, bank account, or private payment identifiers in this public repository. Provide any billing/contact details required for a specific engagement privately.

## Browser Studio data plane

SPOOL's browser Studio is designed to process migration rows locally in the user's browser. CSV rows are parsed, profiled, transformed, validated, checkpointed, and exported by application code in the browser. The current production CSP includes `connect-src 'none'`, and the Studio has no application dataset-upload API, advertising tracker, analytics endpoint, remote model call, WebSocket, or beacon path.

Browser workspace state is stored in IndexedDB under the user's browser profile. The current SPOOL application workflow does not send CSV rows to a SPOOL-controlled server.

## Local runner

The current Gate-B runner processes filesystem CSV input and SQLite targets in the user's/customer environment. It stores local checkpoint/evidence files and target reconciliation evidence as described in `docs/DATA_HANDLING.md`. Current filesystem/SQLite execution does not require SPOOL-hosted credential storage.

## Public GitHub interactions

Repository issues, including Migration Assessment issues, are public GitHub content. Do not submit source rows, database dumps, credentials, personal records, confidential URLs, or other sensitive information there. Initial qualification should use metadata only: source/target type, approximate size, problem, deadline, and sensitivity classification.

## Technical demo hosting

A public static demo may be served by a third-party hosting provider. That provider may process ordinary request/security metadata such as IP address, path, user agent, timestamps, and platform logs under its own terms. The demo is not the paid customer data plane; commercial migrations should use the local runner/customer environment unless a separately approved hosted architecture exists.

## Commercial engagements

A paid migration may require contact, billing, support, and customer-provided technical information. Prefer customer-local execution and sanitized metadata. If real customer data must be accessed, the accepted quote/order should define the access/transfer method, purpose, retention/deletion expectations, and any special confidentiality/security requirements.

## Cookies and analytics

The current SPOOL Studio does not intentionally include application analytics, advertising, or behavioral tracking. Re-check this before enabling any future hosted analytics or third-party scripts.

## Retention

Browser-local migration state remains in browser storage until removed by the user/browser or replaced by product workflow. Local-runner state and SQLite ledger evidence remain in customer-controlled files/targets until removed under the customer's retention policy.

Public GitHub content and technical hosting logs are retained according to those third-party providers. Commercial correspondence, quotes, invoices/receipts, and payment records may need to be retained privately for support, tax, accounting, or dispute purposes.

## Security

SPOOL applies deterministic execution, bounded data exposure, source/target identity binding, fail-closed approvals, fencing, crash reconciliation, verification, and restrictive browser network policy within the current capability matrix. No technical system can guarantee absolute security.

Security reports follow `SECURITY.md`; do not publish exploit payloads containing sensitive data.

## Individual rights and jurisdiction

Applicable privacy/access/deletion rights depend on the provider's and customer's jurisdictions and the data involved. For any engagement that materially processes personal/regulated data beyond customer-local execution, add the legally required rights/contact/processing language before accepting that scope.

## International or regulated work

For cross-border, regulated, highly sensitive, or enterprise engagements, check applicable privacy, tax, transfer, confidentiality, and data-processing requirements before accepting the work. Do not claim this repository template alone is sufficient for every jurisdiction.

## Publication checklist

- provider identified as Dharan Tej Reddy Poduvu, individual service provider;
- no unnecessary private identity/payment details published;
- actual demo hosting provider disclosed where relevant;
- actual customer data flow matches this notice;
- no analytics/cookies enabled without disclosure;
- customer-local execution preferred;
- cross-border/regulated processing reviewed before accepting high-risk scope.
