# Benchmark baselines

No blessed baseline is recorded yet. A baseline is a `benchmarks/results/<suite>/<timestamp>/` directory
copied here after a release-gate run on declared reference hardware, so later runs can fill
`comparison.json` with same-environment deltas.

Until then every run records `comparison: { comparable: false }` instead of inventing a comparison.
Recording a baseline requires: the release-gate green on the exact commit, the reference hardware
identity in `manifest.json`, and reviewer sign-off. Do not fabricate baselines from unmatched machines.
