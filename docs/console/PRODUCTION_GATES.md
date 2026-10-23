# Production gates and current status

The Console is qualified by the engine's own production gates plus the
Console-specific gates below. Honest status at this release preparation:

| Gate | Requirement | Status |
| --- | --- | --- |
| G1 Engine release integrity | manifest binds commit sha + aggregate hash; boot refuses mismatch | **PASS** (harness `verifyRelease.verified: true`) |
| G2 Capability-policy verification | `verifyProductionPolicy` passes at boot and in diagnostics | **PASS** (49 capabilities) |
| G3 Real journey through the engine | create → plan → dry-run → approve → execute → receipt VERIFIED | **PASS** (node test + Electron-level harness, 40/40 rows) |
| G4 Verifier truthfulness | written/chosen counts from engine; receipt only when verified | **PASS** |
| G5 Source immutability between steps | fingerprint re-checked before each mutating step | **PASS** (test: modified source fails closed) |
| G6 Duplicate-run protection | adapter-level synchronous guard + engine lease fencing | **PASS** (test) |
| G7 Renderer containment | sandbox, CSP `connect-src none`, single invoke channel, strict contract validation | **PASS** (code + tests) |
| G8 Evidence reproducibility | sha256 manifest exports and tamper rejection | **PASS** (test) |
| G9 Native ABI alignment | better-sqlite3 matches Electron 40.10.6 (ABI 143) | **PASS** (packaged run + boot probe) |
| G10 Windows application boot (dev + packaged) | window renders against the real engine manifest | **PASS** (screenshots, empty stderr) |
| G11 Signed installer | signer-qualified NSIS executable | **NOT EXECUTED** - no certificate; unsigned build labelled (PACKAGING.md) |
| G12 Clean-machine install qualification | SmartScreen/AV behaviour on a pristine machine | **NOT EXECUTED** - no VM available |
| G13 External-database conformance | postgres/mysql/mssql conformance suites | **NOT APPLICABLE** for the qualified Console scope; engine suites self-skip |

## What the gates do NOT claim

- No enterprise multi-tenant story, no auto-update channel, no cross-machine
  approval portability (by design).
- The Console is NOT a new authority: it is a hardened local operator for the
  same qualified engine; it does not lower engine gates (it cannot).

## Go/no-go recommendation for this release

GO for: internal single-operator Windows use of CSV → ordinary-SQLite-table
INSERT migrations within the qualified ceilings, using the unsigned packaged
build with explicit file-hash verification.
NO-GO for: unauthenticated distribution, server-side custody, other engines
or targets. Those require the engine's future releases first.
