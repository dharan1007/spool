# Policy 03: Data Classification & Handling Policy (SOC 2 CC6.5, C1.1, P1.1)

## 1. Objective
Define strict classification categories and protection requirements for data handled, migrated, or transformed by SPOOL.

## 2. Classification Levels
- **Level 1 — Public**: Release documentation, public capability matrices, open-source packages.
- **Level 2 — Internal**: Operational telemetry, Prometheus counters/gauges, anonymized migration timing statistics.
- **Level 3 — Confidential / Customer Data**: Customer CSV/XLSX sources, database connection strings, table schemas, migration records.
- **Level 4 — Restricted / Secrets**: Asymmetric release private keys, DPAPI approval keys, database credentials, customer API keys.

## 3. Data Sovereignty & Processing Invariants
1. **Zero Cloud Telemetry in Self-Hosted Mode**: Data rows never leave the customer's machine. The browser and desktop console mandate a Content-Security-Policy with `connect-src 'none'`.
2. **Volatile Worker Memory Only in Managed Mode**: In cloud-managed deployments, customer data is streamed strictly through volatile in-memory buffers directly to customer targets. No persistent caching of raw data rows occurs in control plane databases.
3. **Spreadsheet Formula Injection Neutralization**: All CSV/TSV exports must automatically sanitize formula prefixes (`=`, `+`, `-`, `@`) to prevent CSV injection attacks in spreadsheet software.
4. **Data Minimization & Redaction**: Error envelopes returned to clients must pass through recursive redaction replacing passwords, tokens, and authorization headers with `[REDACTED]`.
