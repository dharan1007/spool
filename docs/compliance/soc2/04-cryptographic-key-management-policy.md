# Policy 04: Cryptographic Key Management Policy (SOC 2 CC6.1, CC6.7)

## 1. Objective
Specify technical standards for the generation, rotation, storage, and revocation of cryptographic keys used for artifact signing, approval authorization, and credential protection.

## 2. Standards
1. **Algorithms**:
   - Release signing: Ed25519 (Edwards-curve Digital Signature Algorithm).
   - Approval signatures: HMAC-SHA256 with minimum 256-bit entropy.
   - Evidence digests: SHA-256 canonical hashing (`sha256Canonical`).
   - API keys: CSPRNG 256-bit random keys (`randomBytes(32)`), stored as SHA-256 hashes.
2. **Storage**:
   - Master release private keys must be held in offline hardware security modules (HSM) or encrypted CI secrets.
   - Client approval keys must be encrypted with OS-level hardware encryption (DPAPI on Windows, Keychain on macOS). Refusing plaintext fallback is mandatory.
3. **Rotation & Archival**:
   - Release signing keys must be rotated annually. Deprecated public keys are archived in `keys/archive/` to ensure historical receipts remain verifiable in perpetuity.
   - API keys support dual-key rotation (new key active before old key is revoked).
