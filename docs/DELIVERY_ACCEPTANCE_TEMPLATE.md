# SPOOL Delivery & Acceptance Template

> Operational template only. This document records delivery evidence and acceptance criteria; it is not a substitute for a legal contract.

## Delivery manifest

**Customer:** `[customer]`  
**Quote / scope reference:** `[SPOOL-Q-YYYY-NNN]`  
**Migration ID:** `[migrationId]`  
**SPOOL version:** `[version]`  
**Release commit:** `[40-character SHA]`  
**Delivery date:** `[ISO timestamp + timezone]`

### Delivered artifacts

- `[ ]` Input/source description or source snapshot reference (no unnecessary raw-data duplication).
- `[ ]` Cleaned/import-ready output where in scope.
- `[ ]` Rejected-row / violation summary where applicable.
- `[ ]` Mapping/schema notes.
- `[ ]` Target verification result where target execution was in scope.
- `[ ]` SPOOL receipt / receipt hash where available.
- `[ ]` Known exclusions or unresolved records.
- `[ ]` Re-run/recovery instructions if applicable.

### Delivery locations

List the private/customer-controlled locations used to hand off artifacts. Do not place production data or credentials in a public GitHub issue.

`[private delivery location/reference]`

## Verification summary

**Source rows:** `[count]`  
**Written/accepted rows:** `[count]`  
**Rejected rows:** `[count]`  
**Filtered rows:** `[count]`  
**Verification status:** `[VERIFIED / not applicable]`  
**Receipt/reference:** `[hash/reference]`

For a verified target run, row accounting must reconcile:

```text
source rows = written rows + rejected rows + filtered rows
```

## Acceptance criteria

The customer and provider agreed that the work is accepted when:

- `[ ]` The stated deliverables are received.
- `[ ]` The agreed output/target result satisfies the written scope.
- `[ ]` Rejected or unresolved records are explicit rather than silently omitted.
- `[ ]` Required verification evidence is supplied.
- `[ ]` Any agreed import or target validation check passes.
- `[ ]` No unresolved blocker remains within the quoted scope.

## Customer acceptance

Select one:

- `[ ]` **Accepted.** The customer confirms the acceptance criteria above are satisfied.
- `[ ]` **Accepted with documented exceptions.** Exceptions: `[list]`.
- `[ ]` **Not accepted.** Failed criterion and evidence: `[describe]`.

**Customer representative:** `[name + role]`  
**Date/time:** `[ISO timestamp + timezone]`  
**Written acceptance reference:** `[email/thread/signature reference]`

## Provider closeout

- `[ ]` Payment status recorded privately.
- `[ ]` Customer data retained/deleted according to the agreed handling method.
- `[ ]` Receipt/evidence archived in the private engagement record.
- `[ ]` Optional case-study consent handled separately; acceptance is never conditional on marketing consent.
