# SPOOL Enterprise — SOC 2 Type I Controls Matrix

> Internal mapping document. Not an audit, not an attestation, not a SOC 2 report —
> no independent auditor has reviewed it. See `README.md` in this directory and
> `engineering/completion/BLOCKERS.json` B004 (`NOT_AUDITED`).

| Control ID | Trust Service Criteria | Control Description | Verification Evidence |
|---|---|---|---|
| **CC6.1** | Logical Access | User authentication required via API Key, Bearer Token, or SSO. | `src/daemon/spoold-v2.js`, `src/platform/api-keys.js` |
| **CC6.2** | User Registration & Role Assignment | RBAC enforces `admin`, `operator`, `viewer`, `api-client` role boundaries. | `src/platform/rbac.js`, `tests/rbac.test.js` |
| **CC6.3** | Access Revocation | Immediate revocation of API keys via delete endpoints. | `src/platform/api-keys.js` |
| **CC6.6** | Boundary Protection | Content-Security-Policy disallows untrusted network egress; local data stays local. | `apps/console/electron/security.js` |
| **CC6.7** | Code Integrity | Zero dynamic code evaluation (`eval`), release signed with Ed25519. | `src/platform/signing.js`, `scripts/production-purity.js` |
| **CC7.2** | System Monitoring & Audit | Append-only immutable structured audit log with queryable timestamp filters. | `src/daemon/audit-log.js`, `tests/audit-log.test.js` |
| **CC7.3** | Incident Response | Documented incident response runbook with severity classification and escalation paths. | `docs/operations/incident-response.md` |
| **PI1.1** | Processing Integrity | Strict input parsing; fail-closed on type mismatch or mapping ambiguity. | `src/core/transforms.js`, `src/core/errors.js` |
| **PI1.2** | Execution Proofs | Cryptographic receipts binding exact SHA-256 source and target contract hashes. | `src/execution/receipt.js`, `tests/receipt.test.js` |
| **PI1.4** | Checkpoints & Resumption | Checkpoint manager records durable offsets; leases enforce single-writer serialization. | `src/execution/checkpoint.js`, `src/execution/lease-store.js` |
