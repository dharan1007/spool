# Engineering Contract — Rules A–G (mandatory for pact / kata / spool / faultline)

This document imposes the same release contract on all four repositories.
Agents must read it before touching product features. CI enforces the
machine-checkable subset via `scripts/contract-gate.mjs`.

## Rule A — synthetic tests are development tools, not commercial evidence

Agents may create unit tests, fuzz inputs, mocks and synthetic regression
cases during development. They may NOT use those as primary evidence that a
product beats competitors or is production-ready.

Every commercial capability needs at least one of:

- an official external benchmark;
- an upstream open-source project's real historical failure / workload;
- an actual vendor sandbox;
- an actual PostgreSQL / MySQL / ServiceNow / GitHub / AWS / etc. instance;
- a public dataset;
- a reproducible field workload supplied by a design partner.

A self-created JSON fixture proving a self-created function works proves
almost nothing commercially. `capability-matrix.json` must cite the external
evidence for every `PRODUCTION` capability. Synthetic-only capabilities stay
`EXPERIMENTAL` or below.

## Rule B — no benchmark modification

Agents must never:

- modify benchmark task definitions;
- edit expected outputs;
- exclude failures without publishing the exclusion (id + reason + link);
- detect benchmark task IDs and special-case them;
- hard-code answers;
- tune on the benchmark's held-out evaluation split;
- silently increase budgets for your product but not the comparison;
- compare different models / hardware / tool limits and call it a product win.

Every benchmark repository must be pinned to a Git commit SHA.
Every container must be pinned by digest when practical.
`benchmarks/manifests/*.json` records the pins. The gate fails on forbidden
keys (`expectedOutputs`, `excludedFailures` without reason, `specialCaseIds`,
`hardcodedAnswers`, `tunedOnEvalSplit`, asymmetric budgets).

## Rule C — identical comparison conditions

A competitive experiment must record all of:

benchmark commit, competitor/product version, your commit SHA, operating
system, CPU, RAM, GPU if applicable, database versions, browser versions,
LLM model/version, reasoning configuration, temperature, token budget,
tool-call budget, wall-clock timeout, retry policy, network configuration,
seed, prompt/scaffold, human interventions, cost, raw outputs, final score,
all failures. No missing fields.

`benchmarks/results/<suite>/<timestamp>/` stores `manifest.json`,
`environment.json`, `raw/`, `metrics.json`, `failures.json`,
`comparison.json`, `report.md`, `sha256sums.txt`. The gate validates the
field list in `--strict` mode.

## Rule D — a release can fail

Never automatically lower a target because the software misses it.

If PACT gets 91% and the comparable reference is 94%, the correct result is:

> Benchmark gate failed: 91% < 94%.

Not: "91% is production-ready because architecture improved."

`benchmarks/baselines/*.json` holds the reference scores. Runners exit
non-zero when the target is missed. Progress and superiority are reported
separately.

## Rule E — prohibit fake production code

Production paths must contain none of:

- `TODO` / `FIXME` referring to required behavior
- `NotImplemented` / `notImplemented`
- `dummy provider` / `dummyProvider`
- `fake success` / `fakeSuccess`
- hard-coded benchmark output
- `demo-only` branch
- `mock result` / `mockResult`
- sleep-based synchronization (`sleep(` in prod, `setTimeout` used as a
  correctness gate)
- catch-all → success (`catch` that returns ok/true/success)
- random generated evidence (`Math.random` flowing into evidence)
- silent fallback to local fake data (`fallback` + `fake`, `FAKE_DATA`)

Mocks may exist only beneath testing namespaces (`test/`, `tests/`,
`__tests__/`, `*.test.*`, `benchmarks/` fixtures with explicit `synthetic`
label). `scripts/contract-gate.mjs` scans production paths. Suppression
requires `// contract-gate:allow <reason>` on the same line and is audited.

## Rule F — every capability gets four statuses

Every customer-visible capability must appear in `capability-matrix.json`
with exactly one of: `PRODUCTION`, `EXPERIMENTAL`, `PLANNED`, `UNSUPPORTED`.

A connector does not become `PRODUCTION` because it connected once. Require:

> implementation + real integration test + fault test + security test +
> load test + benchmark evidence + documented limits = PRODUCTION

The gate validates the status vocabulary and the PRODUCTION evidence bundle.
Anything weaker stays `EXPERIMENTAL` or below.

## Rule G — evidence must be immutable

Required layout (all four repos):

    benchmarks/
      manifests/   suite definitions + pins
      adapters/    benchmark-specific shims (no task edits)
      runners/     comparison runners (record Rule C fields)
      baselines/   reference scores (Rule D targets)
      results/     immutable runs, one dir per run
      reports/     human summaries pointing at results/

Each run produces:

    results/<suite>/<timestamp>/
      manifest.json      source commit, benchmark commit, competitor
                         version, environment fingerprint
      environment.json   full Rule C environment
      raw/               unmodified tool outputs
      metrics.json       scores + costs + budgets
      failures.json      every failure, no silent exclusions
      comparison.json    control vs treatment under identical conditions
      report.md          narrative + links
      sha256sums.txt     hashes of everything above

The release process hashes (and where configured, signs) this directory.
`--strict` gate verifies hashes when `sha256sums.txt` is present.

## Enforcement

- `npm run check:contract` — fast gate (structure + matrix + manifests +
  fake-code scan as warnings→errors for ERROR patterns).
- `npm run check:contract:strict` — release gate (warnings become errors,
  Rule C completeness + hash verification enforced).
- Release workflows must call the strict gate. A failing gate fails the
  release. See Rule D.
