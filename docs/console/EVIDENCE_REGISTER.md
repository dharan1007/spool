# Evidence register (SPOOL Console)

Primary machine-readable register: `docs/console/requirement-register.json`
(R1–R22 with status + pointers). Human-readable narrative:
`REQUIREMENTS_MATRIX.md`.

## Evidence files (this release)

| File | What it is |
| --- | --- |
| `.console-evidence/ipc-harness.json` | Full journey driven through the production IPC router inside Electron: release verified, 40-row CSV inspected, plan bound, dry-run 40/0, approval bound, execute COMPLETE, receipt VERIFIED (40 written / 0 rejected), target contains 40 rows, evidence verified, unknown op rejected |
| `.console-evidence/packaged-window.png` | Screenshot of the packaged `SPOOL Console.exe` running (engine 1.1.2, commit c9f8299) |
| `.console-evidence/console-window.png` | Screenshot of the dev-run window |
| `.console-evidence/baseline-npm-test-console.log` / `baseline-npm-test.log` | Root engine suite output (476 pass / 64 skip) and additional baseline runs |
| `apps/console/tests/*.test.js` | Engine-coupled automated suites (journey, tamper, duplicate-run, modified-source, contract negatives, mapping validation) |
| `scripts/harness.js` output | Reproducible Electron-level verification command |

## Reproduction commands

```powershell
cd apps/console
npm test
node_modules\electron\dist\electron.exe scripts\harness.js
npm run package:dir
.\dist\package\win-unpacked\"SPOOL Console.exe"
```

## Rule observed

Nothing in this register claims pushed/merged/success beyond what was actually
executed on this machine. Windows-only steps that could not run here are marked
NOT_EXECUTED, never substituted with Linux results.
