# SPOOL Commercial Support

SPOOL's MIT-licensed source repository is currently private; its engineering issues and release files cannot be assumed available to unauthenticated customers. Commercial migration work is a separate scoped service relationship.

## Public channels

Use the published metadata-only SPOOL Tally assessment (https://tally.so/r/7XlNdA) for public project inquiries. It collects business contact details and categories through the third-party Tally service, not production rows. GitHub engineering issues remain accessible only to authorized repo collaborators. No public intake carries an implied response-time SLA.

The **SPOOL Migration Assessment** Tally form is the public initial qualification path. It asks for business email, company/team, source/target category, size and urgency, and a safe summary. It explicitly prohibits raw rows and secrets. Tally handles the submitted metadata under its terms and privacy practices.

## Commercial engagement boundary

A paid engagement begins only after the parties establish:

1. a private contact channel;
2. an agreed statement of work or order identifying the migration outcome;
3. the systems/files in scope and the environments SPOOL may access;
4. backup/rollback responsibilities;
5. acceptance criteria and deliverables;
6. price/payment terms;
7. support or response targets, if purchased;
8. any customer-specific security/data-handling terms.

No web form, private issue or public inquiry constitutes authorization to mutate a production database.

## Severity model for scoped engagements

Response targets apply only when explicitly included in the signed commercial scope. They are targets, not an implied repository-wide SLA.

| Severity | Definition | Typical handling |
| --- | --- | --- |
| S0 | Suspected security compromise, data-integrity corruption, or unsafe unintended mutation in an active paid migration | Stop mutation, preserve evidence, isolate target, begin incident handling through the agreed private channel |
| S1 | Paid migration blocked with no safe workaround | Prioritize diagnosis and recovery within the purchased support window |
| S2 | Material degradation or incorrect non-destructive behavior with a safe workaround | Schedule corrective work according to the engagement |
| S3 | Question, documentation problem, enhancement or non-critical defect | Normal scoped support queue |

## What to include in a private support case

Start with metadata rather than data:

- SPOOL release version and commit SHA;
- migration/plan/receipt IDs;
- source and target categories;
- exact SPOOL error code;
- sanitized row counts and violation counts;
- operating system and Node/browser version;
- whether the issue reproduces with a generated fixture.

Only provide real rows or credentials when the written engagement explicitly requires them and the agreed private transfer mechanism permits them.

## Recovery principles

For database execution, support must never respond to an uncertain commit by blindly replaying writes. Use target-ledger reconciliation, checkpoint evidence, source snapshot identity, target-contract identity and migration receipt data to determine the safe next action. `CONFLICT`, `INDETERMINATE`, stale fencing, changed source or changed target contract are fail-closed states.

## No silent expansion of scope

The current production connector claim is limited to the capability matrix documented in the README and release evidence. PostgreSQL/MySQL, arbitrary remote connectors, destructive replace/truncate strategies, triggered SQLite targets and unbounded datasets are not implicitly supported because a customer asks during an engagement; they require a separately implemented and conformance-tested capability.
