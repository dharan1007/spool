# SOC 2 mapping documents — internal, not an audit

This directory holds SPOOL's **internal** control documentation, written against the
SOC 2 Trust Services Criteria so the work can be handed to an auditor later.

It is not an audit, not an attestation and not a SOC 2 report. No independent
auditor has reviewed these documents, the code or the generated evidence. The
honest label for the compliance domain is `NOT_AUDITED` (see
`engineering/completion/BLOCKERS.json` B004).

What exists:

- Policy documents (`0*-*.md`), the security policy, the SLA/support policy, the
  data processing agreement, the business continuity/disaster recovery plan and
  the vendor assessment response.
- `controls-matrix.md`, which maps each control to the code and tests that
  implement it.
- `scripts/internal-control-self-assessment.js`, a repeatable check that the
  mapped engineering controls still hold at the current commit. Its report is
  written with `attestation: false` and an explicit disclaimer.

What does not exist, and must not be claimed:

- An auditor-issued SOC 2 Type I or Type II report.
- An observation window, sampling, management assertions, or an auditor opinion.
- Any statement that an internal self-assessment makes SPOOL "SOC 2 compliant".

A passing self-assessment means the mapped engineering checks still hold. It says
nothing about the design or operating effectiveness of organisational controls,
which is what an audit examines.
