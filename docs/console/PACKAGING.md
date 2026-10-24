# Packaging

## What is produced

`npm run package:dir` (apps/console):

1. rebuilds the renderer (`vite build` → `dist/renderer`),
2. runs `@electron/rebuild` logic through electron-builder to match
   `better-sqlite3` to the pinned Electron 40.10.6 ABI (143),
3. packs `electron/`, `preload/`, `service/`, `dist/renderer/` into
   `app.asar` with `asarUnpack` for the native module,
4. copies the **engine bundle** (`engine/`, manifest included) via
   `extraResources` to `resources/engine/` so its bytes stay verifiable
   outside the asar,
5. emits `dist/package/win-unpacked/SPOOL Console.exe` (x64).

## Engine binding at package time

`sync-engine.mjs` runs before packaging (`prepackage`), regenerating
`apps/console/engine/` from the repo `src/` and writing `manifest.json` bound
to `git rev-parse HEAD` and the aggregate hash. The boot path reads the
manifest from `process.resourcesPath/engine` in packaged mode and refuses to
start on mismatch (`RELEASE_BUNDLE_UNVERIFIED`) — a swapped engine copy cannot
boot without breaking the identity check.

## Signing reality (this release)

- No code-signing certificate exists in this environment; the build is
  deliberately **unsigned** and labelled as such everywhere (README,
  PRODUCTION_GATES.md, the CSV in `.console-evidence/`).
- `signAndEditExecutable: false` — the bytes of the packaged executable are
  the authentic electron-builder output (no unsigned-edit attempts).
- Distribution: knowing-your-file-hash + controlled internal share. SmartScreen
  will warn on first run; Windows users must run it consciously. Publishing an
  "installer" without signing would lower the bar for tampering, so the first
  release ships the unpacked directory instead.

## What a future signed release must add

1. an EV/OV certificate and `win.sign` configuration (or Azure Trusted
   Signing),
2. `npm run package:nsis` (NSIS target already configured,
   `allowToChangeInstallationDirectory` true),
3. updates disabled or an owner-run update channel (the Console surfaces
   `updates.*` as NOT_CONFIGURED on purpose).

## Zero-cost constraint honored

No purchase, no paid build hosts, no telemetry: electron-builder runs
locally; no GitHub Actions are used for release.
