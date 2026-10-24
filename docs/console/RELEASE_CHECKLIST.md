# Release checklist (SPOOL Console)

## frozen inputs

- [x] Engine release pinned: `1.1.2` (`src/platform/production-policy.js`)
- [x] Capability matrix pinned and hash-bound (`capabilities/matrix.json`)
- [x] Electron pinned: `40.10.6` (ABI 143 with an official better-sqlite3
      prebuild; 45.x has none and MSVC discovery is broken on the release box)
- [x] Console app version: `1.0.0` (independent of engine release identity)

## build

- [x] `npm run sync:engine` — engine bundle + manifest regenerated, 99 files
- [x] `npm run typecheck` (tsc) — clean
- [x] `npm test` (apps/console) — engine-coupled suites green
- [x] `npm run build:renderer` — vite build green
- [x] `npm run package:dir` — packaged, unsigned, win-unpacked emitted
- [x] Root engine suites: `npm test` (root) — 476 pass / 64 skip;
      `static-check`, `build`, `check:model`, `pack:verify` green

## verification (evidence in .console-evidence/)

- [x] Electron-level IPC journey harness JSON (40/40 rows, receipt VERIFIED)
- [x] Dev-window screenshot (`console-window.png`)
- [x] Packaged-window screenshot (`packaged-window.png`), stderr empty
- [x] Tamper/evidence/unknown-op negative paths asserted in tests

## release management

- [x] Branch `feat/spool-console-production`, PR opened to `main`
- [ ] Merge decision by the owner (PR remains the integration path)
- [ ] Signed installer decision recorded (see PACKAGING.md; NOT EXECUTED)

## post-merge obligations

- [ ] Update `docs/console/IMPLEMENTATION_PROGRESS.md` status line
- [ ] Tag decision left to the owner (no tag was created automatically)

## explicit non-goals (this release)

- Mobile/ARM builds, Linux/macOS installers, auto-update channels, telemetry,
  cloud features of any kind.
