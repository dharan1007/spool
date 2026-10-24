# Policy 02: Change Management Policy (SOC 2 CC8.1)

## 1. Objective
Ensure that all modifications to the SPOOL engine, connectors, console application, and security controls are authorized, peer-reviewed, tested, cryptographically signed, and traceable.

## 2. Policy Statements
1. **Branch Protection & Code Review**: Direct commits to the `main` production branch are strictly prohibited. All changes must be delivered via Pull Requests requiring peer code review and passing CI verification.
2. **Deterministic Release Integrity**: Every release must bind the exact Git commit SHA to the distribution artifact root using Ed25519 digital signatures. Releases without valid signatures must fail verification (`verifyRelease()`).
3. **Reproducible Builds**: Two independent builds from the same commit SHA must produce byte-identical distribution bundles (`reproducible-build-evidence.js`).
4. **Purity Scanner Enforcement**: Automated CI scanners (`scripts/production-purity.js`) must inspect all source files for banned patterns (`TODO`, `FIXME`, `mock-result`, `dummy-data`, `silent-fallback`, unverified sleep timers).
5. **Rollback & State Machine Immutability**: Production releases cannot alter previously committed migration batch ledgers or historical receipt IDs. Terminal states in the formal state machine (`COMPLETED`, `CUTOVER_COMMITTED`) remain immutable.
