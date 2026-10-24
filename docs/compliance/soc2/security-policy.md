# SPOOL Enterprise — Information Security Policy (SOC 2 CC6.1 - CC6.8)

## 1. Purpose & Scope
This policy establishes baseline technical, administrative, and physical safeguards for all systems, source repositories, execution engines, and data pipelines associated with SPOOL Enterprise.

## 2. Access Control (CC6.1, CC6.2, CC6.3)
- **Principle of Least Privilege**: Access to production environments, signing keys, and credential stores is restricted to authenticated, role-authorized principals.
- **Role-Based Access Control (RBAC)**: All user interactions are classified under four defined roles: `admin`, `operator`, `viewer`, `api-client`.
- **Credential Storage**: Cryptographic keys and database credentials must never reside in source control or cleartext files. Keys must be protected via OS-level hardware security (DPAPI/Keychain) or managed Secret Stores (HashiCorp Vault, AWS Secrets Manager).

## 3. Cryptographic Verification & Software Integrity (CC6.6, CC6.7)
- **Release Integrity**: Every binary and bundle release must be cryptographically signed using Ed25519 keys, bound to verifiable Git commit SHAs and SHA-256 artifact manifests.
- **Code Execution Restrictions**: In accordance with the non-negotiable SPOOL invariant, arbitrary dynamic code execution (`eval`, `new Function`, arbitrary shell scripts) is strictly prohibited in all data migration paths.

## 4. Transmission & Network Security (CC6.6)
- **Local-First Boundary**: Local installations process data on-premises without cloud telemetry or data leakage (`connect-src 'none'`).
- **Encrypted In-Transit**: Any network transmission over REST or database connectors must mandate TLS 1.2 or higher.
