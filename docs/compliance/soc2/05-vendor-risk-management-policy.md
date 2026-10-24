# Policy 05: Vendor Risk Management Policy (SOC 2 CC9.2)

## 1. Objective
Assess, monitor, and mitigate security and operational risks associated with third-party software dependencies, cloud infrastructure providers, and external sub-processors.

## 2. Requirements
1. **Zero-Bloat Dependency Standard**: The core SPOOL execution engine maintains minimal runtime dependencies (`better-sqlite3`, `pg`, `mysql2`, `mssql`). Generic utility libraries (`lodash`, `moment`, `prom-client`, `axios`) are banned from production core to minimize attack surface.
2. **Automated Vulnerability Scanning**: Weekly automated Dependabot scanning and npm audit analysis in CI. Any CVE with CVSS >= 7.0 must be remediated within 7 days.
3. **Sub-processor Due Diligence**: Cloud infrastructure sub-processors (AWS, Google Cloud) must maintain current SOC 2 Type II and ISO 27001 certifications.
4. **Supply Chain Pinning**: All production dependencies must be strictly locked with exact SHA-512 integrity hashes in `package-lock.json`.
