# Authorized release trust-root rotation — 14 October 2026

The repository owner explicitly authorized creation and enrollment of a new release signing key after confirming that they did not possess the previously enrolled private key. This is a new trust enrollment, not a signature or continuity claim by the former key.

- Previous fingerprint: `ed25519:fpr:6920f46ff53468f20838ee29de6ba1a10925cebc5502098f0add045f2adee195`.
- New fingerprint: `ed25519:fpr:8c541a008ba211f0ebf48a05d4ace8b9660b4f0ad2407eaf0f25da56e97cd396`.
- Algorithm: Ed25519, generated with Node.js cryptographic key generation.
- New trust root: `keys/release-public.key`.
- Archived former public key: `keys/archive/release-public-pre-20261014.key`; retain it to verify historical releases using their original identity.

The private key is encrypted with Windows DPAPI in CurrentUser scope under `%LOCALAPPDATA%\SPOOL\release-signing\release-ed25519-20261014.dpapi`, outside the repository and OneDrive. The signing directory permits only the current Windows account and SYSTEM. Plaintext private-key material is not written to disk, committed, or printed. An operator wrapper in that directory decrypts it only for the authorized release process and clears the environment afterward.

DPAPI recovery depends on the original Windows account/profile. Protect and back up that account's recovery material through an owner-controlled secure process; copying this encrypted file alone to a different account is not a portable signing backup. Future rotation must be explicit and preserve previous public keys and signed evidence.

Every release under the new enrollment still requires complete exact-source qualification, signed parity verification, retained installed-package identity, immutable publication, staged HTTPS artifact/browser checks, and verification after production promotion. This rotation does not authorize a failed qualification or expand connector support.
