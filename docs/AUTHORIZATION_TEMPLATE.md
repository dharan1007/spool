# SPOOL Target-Mutation Authorization Template

> Operational template only. This is not legal advice and is not represented as lawyer-approved.

Use this before SPOOL or an operator mutates a production/customer database.

## Engagement

**Customer:** `[customer legal/personal name]`  
**Authorized contact:** `[name + role]`  
**Quote / scope reference:** `[SPOOL-Q-YYYY-NNN]`  
**Migration ID:** `[migrationId]`  
**Requested execution window:** `[date/time/timezone]`

## Authorized scope

The customer confirms that it controls or is duly authorized to instruct work on the following target:

**Source:** `[system/file description]`  
**Target:** `[database/system description]`  
**Target table/resource:** `[table/resource]`  
**Permitted target mutation:** `[for current Gate B: INSERT into the named existing SQLite table]`  
**Explicitly excluded operations:** `[delete/replace/truncate/schema changes/other exclusions]`

The authorization is limited to the source, target, operation, mapping/plan, and execution window stated above. Any material change requires renewed written authorization.

## Backup and restore responsibility

Before target mutation, select one:

- `[ ]` Customer confirms a current backup/restore path exists and is responsible for validating it.
- `[ ]` Work is being performed against a disposable/scoped target copy that can be recreated.
- `[ ]` Another written backup/restore arrangement is attached: `[reference]`.

SPOOL verification and reconciliation evidence do not replace the customer's backup/restore responsibility.

## Data handling

The parties agree that public GitHub issues remain metadata-only. Raw production data, credentials, private URLs, database dumps, payment details, and confidential material are exchanged only through the private channel agreed for the engagement.

For the current local-first model, target execution should run on a customer-controlled machine/environment or another specifically authorized local/private environment.

## Authorization statement

> I confirm that I am authorized to approve the target mutation described above. I authorize Dharan Tej Reddy Poduvu, using SPOOL, to execute only the stated scope. I understand the agreed backup/restore responsibility and the explicit exclusions.

**Authorized by:** `[name]`  
**Role:** `[role]`  
**Date/time:** `[ISO timestamp + timezone]`  
**Written acceptance/signature/reference:** `[email/thread/signature reference]`

## Operator pre-run check

- `[ ]` Written authorization received.
- `[ ]` Quote/scope matches the requested operation.
- `[ ]` Backup/restore responsibility confirmed.
- `[ ]` Source and target identities checked.
- `[ ]` Dry run reviewed.
- `[ ]` Bound SPOOL `target_write` approval generated for the exact plan/source/target contract.
- `[ ]` No unsupported/destructive operation is being executed.
