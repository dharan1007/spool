# SPOOL Privacy Notice Template

> **Status: template for legal review.** This is a technical draft, not a published legal privacy notice. The provider identity, contact details, lawful bases, jurisdiction-specific rights and any actual subprocessors must be completed and reviewed before commercial publication.

## Provider

**[LEGAL ENTITY NAME]**

**[REGISTERED ADDRESS]**

**[PRIVACY CONTACT]**

## What the hosted Studio does with migration data

SPOOL's current browser Studio is designed as a local dataset data plane. CSV rows are parsed, profiled, transformed, validated, checkpointed and exported by application code running in the user's browser. The production application Content Security Policy includes `connect-src 'none'`, and the current Studio has no application dataset upload API, analytics endpoint, hosted model call, WebSocket or beacon path.

Browser-local workspace state is stored in IndexedDB under the user's browser profile. SPOOL's application backend does not receive the CSV rows through the product workflow.

## Hosting metadata

The website's hosting/network providers may process ordinary request and security metadata required to deliver static assets, such as IP address, requested path, user-agent information, timestamps and platform security logs according to their own service operation. This technical metadata is separate from SPOOL's migration dataset data plane.

**[COUNSEL/OPERATOR: LIST ACTUAL HOSTING/CDN SUBPROCESSORS AND RETENTION BEFORE PUBLICATION.]**

## Local runner

The current Gate-B local runner processes filesystem CSV input and SQLite targets on the user's machine/environment. It stores local migration/checkpoint evidence and a reconciliation ledger as described in `docs/DATA_HANDLING.md`. Current filesystem/SQLite connectors do not require SPOOL-hosted credential storage.

## Public GitHub interactions

Repository issues, including Migration Assessment issues, are public GitHub content. Information submitted there may be visible to anyone and is also processed by GitHub under GitHub's applicable terms/privacy practices. Do not submit source rows, secrets, credentials, personal records, confidential URLs or other sensitive data to public issues.

## Commercial engagements

A paid migration engagement may require additional contact, billing, contractual, support or customer-provided information. The applicable statement of work and, where needed, data-processing agreement should define the categories of information, purpose, retention, transfer mechanism, subprocessors and deletion obligations. Prefer customer-local execution and sanitized metadata when raw data access is unnecessary.

## Cookies and analytics

The current SPOOL Studio does not intentionally include application analytics or advertising trackers. **[VERIFY AGAIN AT PUBLICATION AND DISCLOSE ANY FUTURE COOKIES/ANALYTICS BEFORE ENABLING THEM.]**

## Retention

Browser-local migration state remains in the user's browser storage until cleared by the user/browser or replaced by product workflow. Local-runner state and SQLite ledger evidence remain in customer-controlled files/targets until removed according to the customer's retention policy.

Retention for public GitHub content, hosting logs, commercial correspondence and billing records depends on the respective service/provider and applicable legal/accounting obligations. **[COUNSEL/OPERATOR TO COMPLETE SPECIFIC PERIODS.]**

## Security

SPOOL applies deterministic execution, bounded agent exposure, no arbitrary generated migration code, source/target identity binding, fail-closed approvals, fencing, reconciliation and restrictive browser network policy as applicable to the current release. No technical system can guarantee absolute security.

Security reports must follow `SECURITY.md`; do not publish exploit payloads containing sensitive data.

## Individual rights

**[COUNSEL TO COMPLETE]** Describe applicable access, correction, deletion, objection, restriction, portability, consent withdrawal and complaint rights for the provider's jurisdiction and customer geographies, together with the verified contact/identity process.

## International transfers

**[COUNSEL TO COMPLETE]** Identify whether hosting, GitHub, support or commercial subprocessors transfer personal data internationally and the applicable transfer mechanism.

## Changes

The published notice should carry an effective date/version and material changes should be reflected before new processing practices are enabled.

## Publication checklist

Do not publish this template as final until the operator/counsel has confirmed:

- legal entity and privacy contact;
- actual hosting/CDN/logging providers;
- actual support/payment tools;
- cookies/analytics state;
- retention periods;
- lawful bases and individual rights;
- subprocessor and international-transfer disclosures;
- data-processing agreement needs;
- applicable Indian and customer-jurisdiction requirements.
