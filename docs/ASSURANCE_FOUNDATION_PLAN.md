# SPOOL Assurance Foundation — bounded experimental implementation

Status: **EXPERIMENTAL RESEARCH**, not an authorized production connector, data-plane API, contractual assurance, certification, or cryptographic zero-knowledge proof.

## Why this exists
A migration can preserve row counts and still break customer relationships, financial totals, application behavior, privacy, or approval requirements. The long-term SPOOL product is independently reproducible acceptance evidence, not another undifferentiated mover. Competitors can copy UI/rules; defensibility requires independently tested versioned destination contracts, audit acceptance and lawful accumulated customer-derived failure cases.

## Implemented as read-only deterministic functions
`src/assurance/foundation.js` is a **Node-only** module, excluded from the Browser Studio's allowlisted public static distribution.

| Proposed moat | Exact implemented boundary | Not yet implemented / proof required |
|---|---|---|
| SPOOL Covenant | Versioned JSON contract with explicit identity keys and bounded, deterministic row-count, unique, field equivalence, exact decimal sum, domain, referential and recorded application observation rules | User/organization signed invariants, external rule editor, live multi-engine, versioned lifecycle and real buyer acceptance |
| Application Shadow Check | Compares pre-recorded source/target application observations, no network or target mutation | Authenticated read-only app adapters, synthetic transactions, redaction and versioned external app fixtures |
| Migration Compatibility Atlas | Strict version-matched diagnostic pack and deterministic signal classification | Official independently qualified SaaS/database packs and ongoing regression corpus |
| SPOOL Rescue Graph | Non-mutating classifications and conservative quarantine/review recommendations | Target ledger reconciliation, transaction fencing, separately authorized repair executor and real failure testing |
| Proof Capsule | Minimal evidence envelope with exact source commit, covenant digest and offline Ed25519 signing/verification when a separate key is provided | External enrolled trust root, canonical privacy review, independent reviewer acceptance, signed production release and customer agreement |
| Counterfactual Migration Lab | Clearly labeled synthetic fault injections and detection results | Real kill/restart/partition/CDC/cutover tests, sustained scale and replay proof |
| Blind Assurance | HMAC-SHA256 keyed commitment; no raw values in output | Per-tenant key custody/rotation and independently audited privacy-preserving protocol. **Not ZK** |
| Dependency Closure Map | Checks coverage and declared critical dependencies against reported status | Actual API/worker/report dependency discovery and authoritative inventory |
| Semantic Drift Sentinel | Exact decimal string comparisons, leading-zero identifier fidelity and offset-aware instant comparison | Currency rules, timezone database, collation/version adapters, regulated financial and multi-engine semantics |
| Independent Cutover Authority | Advisory HOLD/ADVISORY_READY enforcing distinct asserted executor/verifier/approver identifiers and evidence blockers | Strongly authenticated identities, cryptographically separate approvals, real cutover and abort orchestration |

The functions intentionally do not perform external I/O, never alter a production database and refuse unbounded row-array work beyond 10,000 records. Use streaming, customer-scoped live connectors, permissions, transactional evidence and external qualification before permitting larger workloads.

## Threats and explicit limitations
1. A local report can be fabricated by its producer; an Ed25519 capsule verifies bytes and signer provenance **only**, not the truth of independent database observations. Always record provenance, external verifier authority and limitations.
2. HMAC commitments can reveal equality when reused across contexts and can be compromised if the private key is exposed. These are **not** ZK proofs, differential privacy, anonymity or confidential computation.
3. The counterfactual runner models in-memory data differences, **not** a live engine, a faulted SQL transaction or CDC correctness.
4. Record-level comparison is exact JSON value equality, not semantic equivalence for every engine. `semanticCompare` has narrow named modes; unknown cases remain INDETERMINATE.
5. Only declared dependencies are covered; unknown dependencies are explicitly outside evidence. Advisory cutover readiness does not authorize cutover.
6. The proposed recorded application comparison does not execute real app workloads or certify HTTP responses.
7. The current matcher never maps natural keys to identities automatically; ambiguous or missing identities become INDETERMINATE.
8. Proof Capsule operates on metadata only, not raw records, but count/rule outcomes may still be sensitive in small data sets. Customer privacy approval and minimization are necessary.
9. No external shared claim of a hard-to-copy moat is established by these implementations; validate with paid pilots and third-party verification.

## Phase exit gates
- **P0**: Merge only after complete Node tests, current baseline browser tests, Cloudflare preview HTTPS and static-source isolation. Existing `v1.1.2` remains untouched. Signed candidate generated outside Cloudflare with owner's enrolled key. No GitHub Actions.
- **P1**: Build real, authorized, version-pinned importer target pack. Test no unintended writes, customer-safe input metadata, duplicate and relationship resolution, correct end-to-end target result and failure recovery. Third-party pilot operator repeats it without the founder.
- **P2**: Add independently authorized content re-read, API contract observations, durable evidence receipts and external verification. False success in test fixtures is zero; missing evidence is NOT_VERIFIED.
- **P3**: Connect to supported PostgreSQL version matrix only after initial-load, fault-injected restart, transaction-bound snapshot, repair, CDC and cutover proofs. Do not broaden unqualified connectors.
- **P4**: Multi-tenant RBAC/SSO, HSM/KMS, observability, disaster recovery, third-party security and buyer procurement. No certifications are implied until earned.
- **P5**: Repeatable qualified migration partner program, paid contracts, reproducible de-identified compatibility learning (explicit customer consent), published third-party accepted proof semantics.

## Acceptance rubric for live claims
All 12 checks must be evidenced per connector and final release SHA: row/value correctness; commit-before-checkpoint crash safety; multi-table consistency; fail-closed recovery; ordered CDC with durable offsets and visible lag; independent target-content verification; approved convergent repair; measured cutover/abort; negative security/permissions tests; sustained load/real memory/disk/latency; alerts and DR runbooks; reproducible immutable exact-source signed supply chain.

## Extended engineering requirements 31–45
31 Application-level invariants → bind recorded observations to independently authorized live tests; 32 relationship-aware migration → multi-table referential closure and dependency DAG; 33 identity resolution → explicit deterministic key mapping and no silent merges; 34 semantic types → per-engine versioned financial/date/collation contract; 35 pre-existing target → diff and conflict discovery, never blind replace; 36 transaction boundaries → guarantees and fallback documented with real faults; 37 LOB fidelity → byte-exact or fail closed; 38 schema-to-API → consumer contract tests; 39 destination versions → pin and reject unknown packs; 40 verification authority → distinct authenticated signer and release-bound evidence; 41 uncertainty → VERIFIED/MISMATCH/NOT_VERIFIED/INDETERMINATE; 42 quarantine → separate partitions and durable no-auto-replay; 43 consumers → declared+discovered inventories; 44 benchmark parity → identical fixture/hardware and complete verified-workflow throughput; 45 regression lab → every real compatibility finding reproduced with a synthetic fixture and explicit user consent.

## UX requirements 1–20
1 outcome-directed entry; 2 plain-language errors with actionable recovery; 3 destination-first onboarding; 4 effects/disk/unknowns before write; 5 grouped explainable violations; 6 evidence-backed additional format conformance; 7 qualified streamed handoff for large files; 8 versioned target contract selection; 9 identity/association conflict preview; 10 separate execution, reconciliation and business acceptance; 11 before/after with lineage; 12 authenticated role-separated approvals; 13 fail-closed error actions; 14 portable reusable mapping recipes; 15 privacy and zero-row-egress evidence; 16 verified installer; 17 third-party proof verification; 18 sanitized diagnostics; 19 least-privilege role views; 20 privacy-preserving, opt-in measurement. Current website links only to SPOOL's existing bounded functionality and an assessment, not a false public release of these features.

## Business requirements 1–20
1 Public metadata-only lead form, with third-party Tally processing disclosure; 2 legal contracting identity **requires human confirmation and legal registration proof**; 3 production only after final signed release and rollback; 4 public installer requires a separate user-authorized distribution decision; 5 outcome messaging for bounded file preparation; 6 real synthetic example and conversion measurement still needed; 7 offer ranges/scope and approval; 8 banking/UPI/payment, tax identity and accounting **require authorized merchant setup**; 9 customer terms, liability, data processing **require qualified legal review**; 10 technical security overview and genuine disclosure channel; 11 signed installer with independent verification; 12 private support and tested escalation; 13 3 consented truthful customer cases, never fabricated; 14 repeat purchases/referrals; 15 qualified partner resale; 16 conformance-tested versioned integration docs; 17 opt-in anonymous measurement distinct from dataset analytics; 18 real vendor security and continuity assessment; 19 consented customer feedback and lost-deal taxonomy; 20 actual costs, margin, acquisition and retention ledger.

## Commercial evidence
Public lead form: https://tally.so/r/7XlNdA (metadata-only third-party Tally).
No customer submissions, payment, certification, business registration or legal review have been represented as complete in this branch.
