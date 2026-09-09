# SPOOL Support

Use the smallest channel that fits the problem, and never publish customer data merely to obtain help.

## Usage questions

Use repository community channels for setup, architecture and usage questions that are not confirmed bugs. Search existing issues/discussions first so reusable answers remain public where appropriate.

Public repository support has **no response-time SLA**.

## Bugs

Open a bug report using the repository issue form. Include:

- SPOOL release version / commit SHA if known;
- browser or Node/OS version;
- exact SPOOL route/CLI command/workflow stage;
- stable SPOOL error code;
- smallest privacy-safe generated fixture that reproduces the behavior;
- expected versus observed result;
- whether the issue reproduces with the built-in example/conformance fixture.

Never attach private/customer data, credentials, database dumps or confidential URLs.

## Migration assessment

For a real migration, use the **Migration Assessment** issue form. It asks only for non-sensitive scoping metadata: source/target category, approximate size, failure mode, deadline and sensitivity classification.

The issue is public. Do not paste source rows or secrets. If the case is suitable for paid work, a private contact channel and written statement of work must be established before sensitive material is exchanged or production access is granted.

See [`docs/MIGRATION_SERVICES.md`](docs/MIGRATION_SERVICES.md).

## Commercial support

Commercial support is available only as part of an explicitly scoped engagement. A paid engagement defines the private contact mechanism, systems/files in scope, authorization, backup/rollback ownership, acceptance criteria, fee/payment terms and any purchased response targets.

No public issue or repository subscription grants permission to mutate a production target.

See [`docs/COMMERCIAL_SUPPORT.md`](docs/COMMERCIAL_SUPPORT.md) for severity and operating rules.

## Security

Do **not** report vulnerabilities that could expose data or bypass SPOOL's execution/storage boundaries in a public issue. Follow `SECURITY.md`. If a private vulnerability-reporting channel is unavailable, publish only a high-level description and request a private channel before sharing exploit material.

## Data handling

Read [`docs/DATA_HANDLING.md`](docs/DATA_HANDLING.md) before sharing diagnostic evidence. Start with release/migration/plan/receipt IDs, sanitized counts and error codes rather than source rows.
