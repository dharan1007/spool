# Contributing to SPOOL

Thanks for helping make data migrations more deterministic, inspectable and recoverable.

SPOOL values **correctness over feature count**. A small change with a reproducible migration case and strong tests is more useful than a broad feature that weakens execution or recovery guarantees.

## Good ways to contribute

- Add privacy-safe real-world CSV edge cases and regression fixtures.
- Improve parsing, target validation or deterministic transforms.
- Improve checkpoint/recovery behavior and failure diagnostics.
- Add benchmark cases without changing the benchmark methodology silently.
- Improve WebMCP lifecycle/cancellation behavior.
- Improve documentation, examples and accessibility.
- Propose connector work only with explicit execution, credential and crash semantics.

Look for [`good first issue`](https://github.com/dharan1007/spool/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) and [`help wanted`](https://github.com/dharan1007/spool/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).

## Before opening a pull request

For bugs, include the smallest privacy-safe input that reproduces the behavior. For architecture, connector, security or persistence changes, open an issue first so invariants are agreed before implementation.

Never submit production credentials, private datasets or customer data.

## Development setup

Requirements:

- Node.js 22+
- Python 3 for the optional local static server/browser smoke harness

```bash
git clone https://github.com/dharan1007/spool.git
cd spool
npm ci --ignore-scripts
npm run check
npm run serve
```

Open `http://localhost:8765`.

## Required engineering invariants

Changes must preserve these boundaries unless an explicit design change is accepted first:

1. **No arbitrary generated-code execution.** Do not introduce `eval`, `new Function`, shell execution or equivalent dynamic execution into the migration data path.
2. **Typed output is enforced.** Invalid rows become explicit violations; they are not silently coerced to make a run look successful.
3. **Ambiguity fails closed.** Destructive or materially ambiguous choices require an explicit bounded decision.
4. **One result, one mapping revision.** Mapping revisions cannot create mixed-revision output.
5. **Recovery is deterministic.** A resumed mission must prove what state/checkpoint it is resuming from.
6. **Dataset privacy is a product boundary.** The current browser product does not send dataset contents to an application backend.
7. **Agent and human actions share the same command kernel.** Do not create a second privileged agent-only path.
8. **Benchmarks are evidence, not marketing constants.** Regenerate them and describe environment/methodology honestly.

Read `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md` and `docs/PRODUCTION_AUDIT.md` before changing execution or persistence semantics.

## Testing

Run the complete release contract before submitting:

```bash
npm test
npm run build
npm run benchmark
node scripts/static-check.js
npm run check
```

If your change touches browser behavior, also attempt:

```bash
python3 scripts/browser-smoke.py
```

If the environment prevents browser networking, state that explicitly in the PR instead of reporting an unexecuted browser test as passing.

## Pull-request standard

A useful PR explains:

- the concrete problem,
- the invariant or user outcome affected,
- why the chosen design is bounded,
- tests added or changed,
- benchmark impact where relevant,
- security/privacy implications,
- screenshots or a minimal migration case for user-facing behavior.

Keep PRs focused. Unrelated refactors make migration/security review harder.

## Benchmark changes

If a PR changes the benchmark implementation or fixture, regenerate:

```bash
npm run benchmark
```

Commit the resulting `benchmarks/latest.json` and `docs/BENCHMARKS.md` only when the benchmark change is intentional. Do not present local measurements as universal performance claims.

## Security reports

Do not open a public issue for a vulnerability that could expose data, bypass validation, weaken isolation or produce unsafe execution. Follow [`SECURITY.md`](SECURITY.md).

## Contributor credit

Substantive contributors are credited through Git history, release notes and GitHub's contributor graph. If your PR materially extends a migration capability, include a reproducible example so future users can discover the contribution.