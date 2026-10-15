# SPOOL Commercial Launch Kit (draft: requires operator/legal approval)

**Current scope:** Browser Studio accepts CSV/XLSX files ≤50 MiB, with source rows kept in the browser. The separately qualified v1.1.2 local runner supports UTF-8 filesystem CSV → pre-existing ordinary SQLite table, INSERT-only, ≤256 MiB default. Advanced assurance `src/assurance/foundation.js` is **experimental read-only code**, not a commercially certified migration target.

## Public intake — operational

- Public metadata-only request: **https://tally.so/r/7XlNdA**.
- As a third-party intake service, Tally processes the respondent's business email, company/team and project metadata. The form warns against entering production data, credentials, private URLs, dump names or confidential records. It includes CAPTCHA and acknowledgement.
- Admin must review new submissions inside the connected Tally workspace; **no automated email or response time is promised or configured**. Validate with one genuine opt-in test submission before claiming the funnel's delivery reliability.
- Assessments do not grant source access, change authority or create a contract. Follow-up uses a separately agreed private channel; do not upload customer datasets to Tally.
- Browser Studio's `connect-src 'none'` remains unchanged; do **not** embed Tally with a script or send dataset rows to it. The site links externally to a separately disclosed service.

## Current pilot offers (nonbinding proposed ranges, INR; quotes depend on written scope)

| Offer | Scope included | Excluded | Proposed pilot range |
|---|---|---|---|
| Import risk preflight | Review permitted local CSV/XLSX evidence, classify input problems and produce a non-mutating summary | Data import/mutation, enterprise connector work, regulated data access | ₹2,500–₹7,500 |
| Import-ready file | Approved deterministic mapping, typed export and bounded exception report | Guaranteed acceptance by every third-party importer, arbitrary custom integration | ₹5,000–₹15,000 |
| Failed import diagnosis | Inspect externally supplied permitted state/evidence and propose a safe next-action plan | Blind replay, direct production writes without separate authorization | ₹7,500–₹25,000+ |
| Verified customer-local CSV → SQLite | Within v1.1.2 signed bounds; approval + ledger + receipt | PostgreSQL, MySQL, SQL Server, CDC, upsert, arbitrary DDL, enterprise SLA | ₹10,000–₹30,000 |

Quote validity: set in individual agreement; no guaranteed turnaround without assessment. No subscription, unlimited rows, refund promise, support SLA or fixed price is implied by these ranges.

## Intake review and private follow-up

1. Check business email, company/team, source/target category, size band, urgency, problem category and submitted acknowledgement. Mark `NEEDS_MORE_METADATA` if unclear; do not request sensitive rows in public channels.
2. Check against `capabilities/matrix.json`. If unsupported, explicitly mark `RESEARCH_ONLY` or decline; never sell experimental target writes as production-supported.
3. Send the requester a short private response: service scope, technical limits, independent data handling and next meeting/preflight.
4. Obtain the correct legal contracting identity, business address, tax registration and invoicing terms before a binding quote. Existing repository documentation currently names an individual operator; **Aphelion contracting status requires actual authorization/registration verification**, not assumption.
5. Obtain written target authorization, backup owner confirmation, DPA/private-data handling where relevant, out-of-scope list, acceptance criteria and bounded quotation before accessing or mutating customer systems.
6. After delivery, preserve the signed version, exact execution receipt, sanitized findings, customer acceptance, agreed support window and final invoice privately. Never commit the customer ledger or personal data.

## Sample statement of work — NOT legally approved

- **Provider legal name / tax ID / business address:** [complete with authentic records]
- **Customer legal entity / authorized representative:** [required]
- **Systems/source:** [dataset category, size, declared system versions, ownership evidence]
- **Destination:** [actual supported target/version; existing tables; explicit write restrictions]
- **Data sensitivity and transfer boundary:** [customer-local default; any exceptions and processors approved]
- **Services/deliverables:** [exact scope, accepted rows, rejects, plan, receipt and evidence]
- **Customer obligations:** accurate authorization; tested backups; least-privilege access; downtime/change window where applicable
- **Acceptance procedure:** [agreed source/target counts; named business invariants; evidence review; independent sign-off; exceptions permitted]
- **Unsafe/unknown conditions:** fail closed and escalate, never silently retry, do not promise unsupported connectors
- **Fees, payment schedule, refund/termination handling and taxes:** [individual written agreement]
- **Support, liability, confidentiality, incident handling, dispute law:** [qualified legal review]
- **Case-study consent:** separate optional opt-in with explicit redactions, permitted metrics and withdrawal rights

No statement here is an executed contract, independent legal opinion, regulatory certification, insurance, or security audit. Review by a qualified professional before use.

## Operational support and incident workflow

- Intake severity `S0`: suspected corruption, unauthorized data exposure or unintended mutation → stop, preserve evidence, isolate target and engage authorized customer owner.
- `S1`: scoped paid migration blocked with no safe workaround → triage in agreed support window.
- `S2`: material degradation with safe fallback → issue plan and verify recovery.
- `S3`: documentation/normal request → ordinary backlog.
- Never store production samples/credentials in public issues, analytics, Tally or the repository.
- Do not claim 24/7 support, disaster recovery, encryption compliance, availability percentages or security certifications without measured proof.

## Evidence ledger for the 20 business gaps

| # | Requirement | Current evidence | Remaining externally verified exit |
|---|---|---|---|
| 1 | Public lead intake | Tally metadata-only form published | Real opt-in external submission and workflow triage confirmation |
| 2 | Correct identity | Existing docs honestly list current individual provider; site does not claim incorporation | Operator confirms authentic contracting company, billing data and authorized use |
| 3 | Cloudflare production | Connected preview with passing build/reproducibility/HTTPS checks | Owner-signed immutable release, domain promotion and rollback |
| 4 | Public distribution | Public browser Studio preview | Unauthenticated signed runner package and cross-platform install verification |
| 5 | Positioning | Outcome-focused website copy on development branch | Buyer comprehension test and paid demand |
| 6 | Demo funnel | Studio and assessment CTA on branch | Representative task demo + independent funnel metrics |
| 7 | Pricing | Nonbinding bounded price cards in this kit | Legal/tax-approved fixed proposal and real acceptance |
| 8 | Payments | None configured; no false payment claims | Merchant/tax/KYC setup and legitimate paid transaction |
| 9 | Legal | SOW draft prepared here | Independent legal and data protection review |
| 10 | Security | Technical threat model, CSP, artifacts | Third-party security tests and buyer assessment |
| 11 | Installation | Pinned v1.1.2 private source docs | Downloadable independently signed installer + fresh-host test |
| 12 | Support | Severity and fail-closed runbooks | Private live helpdesk, SLA purchase and rehearsed escalation |
| 13 | Case studies | Consent field in draft SOW | Three real customer-consented independently reproducible outcomes |
| 14 | References | No public proof | Repeat purchase or consented referral |
| 15 | Partners | Distribution strategy only | Partner onboarding and independently delivered jobs |
| 16 | Integrations | Capability register/technical docs | Real versioned target conformance and external implementer |
| 17 | Usage measurement | Tally can report form metrics; no dataset telemetry | Real consented baseline and funnel measurement |
| 18 | Procurement | Initial architecture, security docs and this kit | Buyer security/continuity processing assessment |
| 19 | Feedback | Assessment source/target categories | Explicit lost-deal/rejected-workflow review cadence using consented data |
| 20 | Unit economics | Proposed price/scope model below | Actual time/cost/acquisition/retention from paid jobs |

## Unit-economics discipline
For each private engagement record only: `quote_id`, service tier, signed price, receipts, materials/cloud costs, operator+support hours, applicable tax treatment, acquisition costs, revised cost-to-serve and acceptance/return status. Do not put customer details or payment credentials in Git. Contribution margin = net collected revenue minus directly attributable variable costs; customer acquisition cost should use the actual blended acquisition spend divided by new paying customers, never invented placeholder conversion rates. Until paid projects exist, report **NO ACTUAL CUSTOMER UNIT ECONOMICS**.

## Defensibility discipline
Do not present current source code, a dashboard, deterministic hashing, or proposed compatibility heuristics as an independently defensible moat. Create a moat through authorized versioned compatibility findings, validated destination recipes, trusted independent proof verification, partner workflow adoption and real case evidence; explicitly permit lawful customer rejection and protect data rights.
