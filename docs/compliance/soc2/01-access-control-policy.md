# Policy 01: Access Control Policy (SOC 2 CC6.1, CC6.2, CC6.3)

## 1. Objective
Establish formal controls governing logical access to the SPOOL platform, APIs, signing keys, and customer data stores based on the principle of least privilege.

## 2. Policy Statements
1. **Authentication**: All programmatic access requires authentication via SHA-256 validated API keys (`spool_live_` prefix) or bearer tokens (minimum 32 bytes). Anonymous access to migration mutation paths is prohibited.
2. **Role-Based Access Control (RBAC)**: All authorized principals must be assigned exactly one role:
   - `admin`: Full configuration, user and key management, migration execution.
   - `operator`: Create, plan, dry-run, approve, and execute migrations. No user management.
   - `viewer`: Read-only access to migration records, status, receipts, and verification evidence.
   - `api-client`: Scoped programmatic execution without user-management capabilities.
3. **Approval Signing Key Custody**: Approval signing keys must never be exposed via API, serialized to renderer contexts, or stored in plaintext. Local installations must use Windows DPAPI (`safeStorage`) or macOS Keychain. Managed cloud deployments must store master signing keys in AWS KMS, Azure Key Vault, or HashiCorp Vault.
4. **Credential Broker Isolation**: Target database credentials must remain strictly inside the `CredentialBroker` lifecycle. Credentials are never written to disk, never serialized in migration records, and automatically redacted from logs.
5. **Access Revocation**: API keys and tokens must be revoked immediately upon principal offboarding or key compromise via immediate database invalidation.
