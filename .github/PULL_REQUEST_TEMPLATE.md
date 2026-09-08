## Problem

<!-- What concrete migration/user/reliability problem does this PR solve? -->

## Change

<!-- Summarize the implementation and why this is the smallest correct approach. -->

## Evidence

- [ ] I added or updated a regression test/fixture where applicable.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] `npm run benchmark` was run if benchmark/core performance behavior changed.
- [ ] `node scripts/static-check.js` passes.
- [ ] `npm run check` passes.
- [ ] I attempted the browser smoke path if browser behavior changed, or documented why the environment could not run it.

## Safety / invariants

- [ ] No arbitrary generated-code execution was introduced.
- [ ] Typed-output failures remain explicit rather than silently coerced.
- [ ] Recovery/revision semantics remain deterministic.
- [ ] Dataset/network behavior was not widened without explicit review.
- [ ] Agent actions still use the canonical command path.

## User-facing proof

<!-- Add a privacy-safe input/output example, screenshot or reproduction when the change is user-visible. -->

## Breaking changes

<!-- None, or describe exact migration/compatibility impact. -->

## Documentation

<!-- List docs changed, or explain why no docs update is required. -->