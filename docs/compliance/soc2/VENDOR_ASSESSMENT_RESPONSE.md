# SPOOL Enterprise — Vendor Security Questionnaire Responses (SIG / CAIQ Core)

**Entity Name**: SPOOL Technologies Inc.  
**Product**: SPOOL Enterprise Data Migration Platform  
**Compliance framework**: internal controls mapped to the SOC 2 Trust Services Criteria, written in an ISO 27001 style. SPOOL holds no SOC 2 report and no ISO 27001 certification, and no independent auditor has reviewed these responses. See `README.md` in this directory and `engineering/completion/BLOCKERS.json` B004 (`NOT_AUDITED`).  

---

### Section 1: Data Protection & Sovereignty
- **Q1.1: Does customer migration data ever leave customer-controlled infrastructure in self-hosted mode?**  
  **Answer**: **No.** In self-hosted and on-premises deployments, SPOOL enforces a strict `connect-src 'none'` Content Security Policy and zero outbound network transmission. Data flows exclusively between customer-designated source and target stores.
- **Q1.2: How is data in transit protected?**  
  **Answer**: All external network interactions (REST API, database connector connections) require TLS 1.2 or TLS 1.3 with strong cipher suites.
- **Q1.3: How are secrets and database credentials stored and managed?**  
  **Answer**: Secrets are protected via the `CredentialBroker` isolation boundary. They are never serialized, never written to disk, redacted from all logs and error messages, and can integrate with HashiCorp Vault or AWS Secrets Manager.

---

### Section 2: Access Control & Authentication
- **Q2.1: Does SPOOL support enterprise Single Sign-On (SSO)?**  
  **Answer**: Yes. OpenID Connect (OIDC) and SAML 2.0 federation are supported for Okta, Azure Active Directory, and Google Workspace.
- **Q2.2: How is role-based access enforced?**  
  **Answer**: Access is governed by four distinct role permissions: `admin`, `operator`, `viewer`, and `api-client`, with workspace-level authorization scoping.
- **Q2.3: How are API keys authenticated and stored?**  
  **Answer**: API keys utilize the `spool_live_` format and are hashed using SHA-256 with timing-safe comparison. Cleartext keys are never stored.

---

### Section 3: Processing Integrity & Cryptographic Proofs
- **Q3.1: How does SPOOL prove that zero data loss or data corruption occurred during migration?**  
  **Answer**: Every completed migration outputs an immutable cryptographic receipt signed by an Ed25519 or HMAC-SHA256 key, binding the source snapshot SHA-256, target contract schema, batch identities, row counts, and content verification proofs.
- **Q3.2: How does SPOOL handle process crashes during high-volume migrations?**  
  **Answer**: SPOOL utilizes a commit-before-checkpoint model paired with monotonic lease fencing tokens. Upon crash recovery, target reconcilers detect previously committed batches and resume without duplicate writes or data loss.
