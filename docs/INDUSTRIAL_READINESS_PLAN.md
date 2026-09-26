# SPOOL industrial production-readiness plan and gap register

Snapshot: 2026-09-27. Experimental engineering plan, not a release certificate. The first flagship is authenticated, verified PostgreSQL mutation/full-load/CDC. Released v1.1.1 remains a narrower product and must not inherit this work before qualification.

## A. Authoritative scope and evidence policy

Main SHA: 333a535a9fe5e04fe6ac6247897c9a9f45238d50. Release: v1.1.1, published 2026-09-11. The main branch is unprotected. The industrial harness, red-team, external-runner, target-contract/cardinality and fail-closed verifier are draft PRs #71, #72, #75, #76, #77, respectively. Website onboarding is separate draft PR #78. The integration candidate is integration/postgres-industrial-p0-20260927.

Recent hosted release/CodeQL jobs report zero executed steps; self-hosted qualification remains queued without actual evidence. This is NOT_EXECUTED, not PASS. Confirm billing/entitlement, runner eligibility, repository policy and runner registration; do not assert a root cause without inspecting account-side evidence. No arbitrary test skip, downgraded security workflow or admin lease deletion counts as remediation.

The historical 43/100 is a subjective development estimate, not certification. Schema-v5 development evidence always declares NOT_QUALIFIED. A CI/SMALL/MEDIUM/LARGE/INDUSTRIAL workload name is not the corresponding production class. No higher class may be issued by the self-reporting harness; independent identity-bound attestation and all mandatory executed gates are required.

## B. Architecture to prove, in exact order

(1) Bind exact source state: hash and durable source, consistent exported snapshot, source relation/row identity, publication, replication slot, timeline and LSN. Reject changed/missing/ambiguous states.
(2) Bind deterministic plan: normalized contract and transform, immutable plan hash, precise effects and capabilities. Unsupported semantics must fail closed.
(3) Establish authenticated authority: verified issuer, audience, signature, nonce, expiry, tenant, action, policy version and authorized subject, never request-body principal.
(4) Obtain independently authorized approval: bind plan, source state, live target contract, effects, risk, actor set, nonce, expiry and revocation. Separate execution and signing identities; high-risk repair/DDL/cutover requires two distinct verified people.
(5) Enter target transaction under DB-clock fencing, re-read exact catalog/session contract while holding a DDL-conflicting lock and retain it through COMMIT or ROLLBACK.
(6) Apply exact mutation: count per SQL statement and RETURNING classification, transactional source CDC order, target rows+ledger, durable checkpoint and ACK in safe order. An ambiguous commit triggers reconciliation, not success.
(7) Independently verify exact target content at a stable observation boundary; ledger COMPLETED and aggregate row totals are never content parity by themselves.
(8) Separately approve repair/cutover; assert source quiescence/barrier and final LSN; recover safely from repair/cutover crash and verify target again.
(9) Emit independently inspectable, canonical signed receipts binding implementation SHA, source/target/plan, authenticated approval set, fences, exact observations, recovery/repair/cutover chain, and limitations.

These invariants must hold identically across CLI, local daemon, GUI, SDK and MCP. No wrapper may bypass the command kernel.

## C. Execution stages and objective acceptance gates

P0-A: Restore mandatory executable CI/release governance. Pin clean SHA, lockfile, trusted runner ID, env config, CodeQL SARIF, dependency audit, static/unit/model, packaging/reproducibility, real PostgreSQL conformance/red-team and browser smoke. Require protected main, PR review, required statuses and signed artifact provenance. Demonstrate that intentionally failing candidate cannot merge. Self-hosted development evidence does NOT substitute for policy-enforced release gates.

P0-B: PostgreSQL target DDL TOCTOU and exact cardinality. Integrate draft #76 and #72: warm the contract, concurrently ADD/DROP/ALTER column, PK/index, trigger/rule/RLS, generated-column and session-setting changes before COMMIT. Check suppression, NULL unique identity, DO NOTHING, updates changing identity, DELETE missing rows and partial RETURNING. Require bounded safe retries and exact target inspection; never return COMMITTED_EXACT after partial effect. Quantify contract-lock throughput and concurrency impact.

P0-C: Authenticated identity / policy. Verify OIDC issuer+audience+JWKS+kid+nonce+expiry, tenant, SCIM disablement, mTLS workload identity and credential rotation. Command-service rejects forged principal from any transport, cross-tenant targets, expired/replayed identities and delegated privilege escalation. Enforce RBAC/ABAC and resource/risk policy server-side, default deny. Bind the resulting trusted auth context to all approval and execution evidence.

P0-D: Separation of duties. Isolate authority to sign target writes, destructive repairs and cutovers from authority to execute. Two independently authenticated approvers and separate keys for high risk; no single bearer token can assert both. Record approver identities, scoped effects, policy/nonce, revocation, TTL and immutable audit; test replay, collusion by duplicate identity, revocation while pending and key rotation.

P0-E: Hard crash + natural lease proof. Child process commits at least one durable batch, then actual Linux SIGKILL before final batch. DB clock shows retained active lease; newcomer refused before expiry; no privileged deletion; natural expiry; new fencing token strictly greater; prior owner tries and fails to mutate; checkpoint and target ledger reconcile without duplicates. Repeat with container/machine loss if available. Force ACK loss, committed-but-uncheckpointed replay, stale worker and ambiguous COMMIT. Fail if fault was not observed or negative assertion did not execute.

P0-F: CDC/source transaction fidelity. Bind exported snapshot and exact logical start LSN; preserve BEGIN/COMMIT atomicity and cross-table sequence. ACK/advance source only after durable target+ledger and checkpoint. Prove TOAST unchanged/changed bytes, REPLICA IDENTITY modes, publication/key changes, TRUNCATE policy, split huge transactions, duplicate replay, slot invalidation and timeline promotion. Unsupported semantics are explicit refusals, never dropped events.

P0-G: Qualification claims. Use schema-v5 NOT_QUALIFIED development manifest and immutable class obligations. Do not transform a clean PASS into releaseGrade/industrialScaleGrade. Build independent verifier with trusted immutable attestations for CI, real PostgreSQL, full required matrix, security, load and provenance; legacy v3/v4 boolean flags cannot become modern class claims.

P1-A: Full PostgreSQL load. Consistent snapshot across readers; exact source cardinality/content fingerprint; snapshot-to-CDC handoff; source and target key/ROW identity. Test JSONB, BYTEA/TOAST, numeric, float, Unicode, NULL, LOB, schema and partition drift; schema evolution only with explicit certified contract transition.

P1-B: Failure matrix. Process kill, machine/container loss, PostgreSQL restart, ambiguous commit, stale worker, deadlock and serialization, concurrent DDL, trigger/rule/RLS, TOAST, >1GiB bounded spill, WAL/slot loss, network partition, DNS/TLS/credential rotation, disk-full/fsync/partial I/O, corrupt checkpoint, failover/promotion, repair/cutover crash, DB clock skew. Each requires fault injection timestamp, independently observed fault, expected semantics, pre/post exact state, convergence, RTO/RPO and authoritative receipt. A fault not reached is NOT_EXECUTED.

P1-C: Scale and performance. Deterministic 100K, 1M, 10M, 100M, eventual 1B rows, profile/payload distribution, exact PG build/extension/config, OS/cloud instance/storage/network version, generator and artifact hashes. Record CPU/RSS, heap, spill/disk, WAL retained and amplified, throughput, p50/p95/p99 latency, source/CDC/checkpoint lag, verification/repair convergence, restart RTO and operating cost. Do not use 10M skipped as 10M PASS. Historical 100K/1M/5M rates are development-only until rerun on exact candidate.

P1-D: HA/distributed worker control plane. DB-clock lease, monotonic fencing, safe work partition, idempotent assignments, queue backpressure and bounded memory. Test partitions, multiworker races, failover/rejoin, routing and slot ownership, coordinator crash, upgrade/rollback/mixed-version compatibility. Versioned APIs require consistent auth and error semantics.

P1-E: Enterprise security and observability. SSO/RBAC/ABAC/SCIM tenant/deprovision; KMS/HSM and secrets/CA rotation; mutable redaction; SIEM-ready immutable audit and W3C OpenTelemetry spans from source snapshot through receipt. Alert on slot/WAL growth, lag, stale fence and unresolved ambiguity. Threat model privilege escalation, supply-chain, SBOM/SAST/CodeQL, pinned dependencies and reproducible provenance.

P1-F: Platform certification. PostgreSQL 14–18 per exact engine patch/build and supported topology, managed-provider versions only after real qualification; TLS/CA, failover and replication slot behavior, unsupported extensions/keyless policies published. Connection smoke is not a platform certification.

P2-A: Operator GUI and APIs. Source/target connection wizard, locale/device-safe data handling, explain actions in human language, exact plan preview, risk/approval queue, monitor lag/fence, guided recovery/repair/cutover, independently downloadable evidence. Never dump JSON as the human-facing screen; retain typed responses for CLI/SDK/MCP and actionable errors. User's hosted UI must not pretend to run remote DB writes; local agent provisioning with trusted authority is necessary. Draft #78 is UX onboarding, not a production database GUI.

P2-B: Support/commercial. Versioned connector SDK/certification, interactive docs and reliable copy-paste examples, supported-version matrix and limits, upgrade runbooks, incident drills, retention/data residency, scoped compliance evidence, legally defined SLA and support staffing. Publish customer case studies only with permission and independently repeatable workloads/receipts. Do not invent enterprise adoption or performance claims.

## D. Explicit cumulative qualification classes (frozen targets, none earned)

CI_CORRECTNESS: at least 100K rows and real 30-second CDC, executed real PG unit/integration/conformance, independent target proof, DDL/cardinality and mandatory CI+security gates.
PILOT: at least 1M rows, 1-hour real CDC; add snapshot-to-CDC, hard kill/natural lease, identity/audit.
SMALL_PRODUCTION: at least 10M rows, 24-hour real CDC; add TOAST/>1GiB spill, ambiguous commit, WAL/slot/DB restart, repair/cutover crash.
MEDIUM_PRODUCTION: at least 100M rows, 72-hour CDC; add HA failover, network/TLS/DNS, disk/fsync, upgrade/rollback.
LARGE_PRODUCTION: at least 1B rows, seven-day CDC; add multiworker repeat failover, measured SLO/RPO/RTO/resource bounds.
INDUSTRIAL: LARGE plus independently repeated certification, two-person approval/SoD/SSO/SCIM/ABAC/KMS/HSM, OTel/SIEM, SBOM/signed release, version/platform matrix and support/SLA/operator drill evidence.
No profile name, boolean status, unchecked metrics file or code commit grants a class.

## E. Living gap register

Category | Priority | Current evidence | Closure
--- | --- | --- | ---
Correctness/protocol | P0 | #76 draft; isolated helper | real DDL/cardinality/identity negative matrix
PostgreSQL full-load | P1 | experimental | consistent snapshot/LSN, independent content and tier proof
CDC transaction fidelity | P0/P1 | experimental | atomic apply/ACK, TOAST/key/pub/WAL fault evidence
Crash recovery | P0 | natural expiry patch drafted; real PG not run | SIGKILL takeover/old-fence/ambiguous commit bundle
Cutover | P0/P1 | experimental | separate approval, barrier, post-crash exact proof
Verification/repair | P1 | experimental | independent parity/repair convergence and negative fixtures
Scale/performance | P1 | local 100K/1M/5M; 10M skipped | sustained 100K–1B measurements with p50/p95/p99
Workers/HA | P1 | experimental | partition/promotion/anti-split-brain tests
Identity/SSO/RBAC/ABAC/SCIM | P0/P1 | caller principal trust gap | real external authN/authZ and lifecycle suite
SoD/two-person | P0 | single signing boundary | independent identities/keys, revocation/replay tests
Secrets/KMS/HSM | P1 | partial local secret controls | rotation, attestation, redaction
Audit/SIEM | P1 | partial receipts/ledger | tamper-evident exported audit, correlation
Observability/OTel | P1 | incomplete | tracing/lag/slot/alerts and documented SLOs
Control plane/agents | P1 | partial | trusted command-kernel parity/negative access suite
Upgrade/rollback | P1 | unqualified | state/schema rolling/mixed-version restoration
Connector certification SDK | P2 | experimental | signed version/feature/support matrix
Security/threat/SBOM/SAST | P0/P1 | mandatory CodeQL unexecuted | executed security gates, SBOM and threat-drill
Chaos/fault | P0/P1 | red-team drafts | executed controlled fault matrix
Platform/version | P1 | unqualified | PG14–18 by exact provider/topology
UX/operator tooling | P1/P2 | website #78 draft | real operator product and E2E accessibility
SDK/API/CLI/MCP | P1/P2 | partial | typed parity, auth, docs, examples, no raw JSON UX
Docs/support/SLA | P2 | templates only | operated runbooks, support rehearsals, contracts
Compliance | P2 | readiness only | scoped assessed controls; no unfounded certification
Release provenance | P0 | existing mechanisms, unenforced CI | protected checks, signed reproducible artifacts
Customers/case studies | P2 | not industrially proven | consented independently repeatable proof
Commercial packaging | P2 | incomplete | priced/versioned supported packages and terms

## F. Relevant competitor capability changes and experiments

Fivetran HVR documents PostgreSQL 9.6–18 log-based CDC, limited DDL adaptation, LOB/TRUNCATE, compare/refresh and checkpoints. SPOOL must not call CDC or verification novel; differentiate only through demonstrated authority-to-exact-target receipts. AWS DMS provides row-level validation, but documents PostgreSQL key/PK definition/deferred constraint limits. Qlik documents certain TRUNCATE/LOB/NULL-unique-key risks; build exact identity/cardinality tests. Striim documents huge transaction handling; qualify >1GiB bounded spill. Airbyte documents CDC schema/slot/failover constraints; compare recovery using exact matched workloads. Do not rank products without controlled, current, identical evidence.

References:
- https://fivetran.com/docs/hvr6/capabilities/635/capabilities-for-postgresql
- https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Validating.html
- https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html
- https://help.qlik.com/en-US/replicate/November2024/Content/Global_Common/Content/SharedReplicateHDD/PostgreSQL-Source/limitations_postgresql_source.htm
- https://github.com/airbytehq/airbyte/blob/master/docs/integrations/sources/postgres/postgres-troubleshooting.md

## G. Immediate next promotion decision

First restore executable trusted release/CodeQL gates. Then execute the consolidated candidate against real PostgreSQL with all relevant conformance, DDL/cardinality red team, physical SIGKILL/natural lease, CDC large transaction, verifier tamper and browser/API regression. Fix any findings and repeat at exact SHA. Next complete verified identity/SoD/two-person authorization and wider failure/scale/HA. Only issue the exact class whose independent gates actually passed; all others remain NOT_QUALIFIED. The protected production branch and v1.1.1 release stay unchanged until those requirements are satisfied.
