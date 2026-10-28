# Evidence index

`scripts/audit-evidence-index.js` produces a deterministic, content-hashed inventory of the
evidence SPOOL already keeps in this repository, so a third party can be handed a manifest
instead of a directory listing.

It is provenance and discoverability tooling. It does **not** qualify a provider, sign a
release, certify compliance or close the independent-audit blocker. Every output states
`attestation: false` and `independentAudit: NOT_PERFORMED`.

## Usage

```bash
# JSON on stdout, one-line summary on stderr
node scripts/audit-evidence-index.js

# Write the index somewhere outside the evidence scope
node scripts/audit-evidence-index.js --out E:\temp\spool-qual\evidence-index.json

# Optional commit provenance (omitted by default so repeated runs stay identical)
node scripts/audit-evidence-index.js --commit "$(git rev-parse HEAD)"
```

Exit codes:

- `0` - the inventory completed. `ABSENT` entries are a recorded result, not an error.
- `1` - the run was refused or could not be completed: an evidence path is not a regular
  file, could not be read, escapes the repository, the output path collides with the
  evidence scope (`EVIDENCE_INDEX_OUTPUT_COLLISION`), or the repository root is not a git
  work tree (`EVIDENCE_INDEX_GIT_REQUIRED`).

## What is inventoried

An explicit allowlist, declared in `EVIDENCE_MANIFEST`:

| Set | Contents |
| --- | --- |
| `completion-registers` | `engineering/completion/*.json` registers plus the qualification report and resume instructions |
| `security-design` | threat model, limits, dependency risk, production audit, self-hosting, WebMCP, architecture, benchmarks |
| `compliance-mapping` | `docs/compliance/soc2/*.md` (internal mapping, not an audit) |
| `release-evidence` | `release/parity-evidence.json`, `release/reproducibility-evidence.json` |
| `signed-release` | `release/release-manifest.json`, `release/release-chain.json` - expected only after an authorized signed release (BLOCKERS B003), reported `ABSENT` until then |
| `generated-evidence` | `.console-evidence/*.json` emitted by executed suites |
| `benchmark-evidence` | `benchmarks/latest.json` |

Each present entry records the normalized repository-relative path, `status: "PRESENT"`,
the byte length, and the SHA-256 of the file's actual bytes. Each absent entry records
`status: "ABSENT"` and no digest.

Only **git-tracked** files are inventoried, so the manifest is identical in a fresh clone
of the same commit. A file that exists in the working tree but is not tracked (for example
the gitignored `release/reproducibility-evidence.json` produced by a local build) is listed
under `localOnly` and excluded from `indexSha256`, rather than being presented as repository
evidence. A git work tree is therefore required; the script fails closed with
`EVIDENCE_INDEX_GIT_REQUIRED` instead of guessing.

Deliberately **not** inventoried: credentials, keys and `.env` files, temporary
directories, build output such as `dist/`, untracked working-tree files, unrelated project
data, and any file not in the manifest. There is no recursive sweep of the repository.

## Guarantees

- **Deterministic.** Entries are sorted by path and serialized with a fixed key order and
  two-space indentation. No timestamps, no absolute machine paths, no environment values.
  Two runs over unchanged inputs produce byte-identical output.
- **Tracked scope only.** The manifest describes the repository, not one machine's leftover
  build output; `localOnly` reports the difference instead of hiding it.
- **Not self-referential.** The index never hashes itself, and an `--out` path that equals
  a manifest file or lands inside a manifest directory is refused before anything is
  written, so writing the index can never change its own input.
- **Honest about absence.** Missing evidence stays visible as `ABSENT`. Unexpected read
  failures abort the run rather than being reported as absence.
- **Cwd independent.** The repository root is resolved from the script location, not from
  the caller's working directory.

Note: the completion registers are themselves evidence inputs, so `indexSha256` changes
whenever a register changes. That is expected; generate the index per candidate rather than
treating a stored digest as a permanent property of the project.

## Related

- `docs/compliance/soc2/README.md` - what the compliance documents are and are not.
- `scripts/internal-control-self-assessment.js` - internal control checks at the current commit.
- `engineering/completion/BLOCKERS.json` - B004 remains `NOT_AUDITED`.
