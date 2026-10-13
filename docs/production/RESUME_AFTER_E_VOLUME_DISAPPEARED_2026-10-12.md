# SPOOL: read-only Windows volume recovery and safe continuation (12 October 2026)

## Current verified checkpoint

- PR #91 is open, draft, unmerged. Last executable Windows checkpoint was `2902b21f0765645b681e5d3a2e924a9cbf1ec123`.
- The local `E:\spool-release\qualification` worktree, `E:\spool-release\evidence`, and `E:\spool-release\temp\spool-browser-venv` became unavailable. Windows volume/disk query reported only C:. Local browser qualification therefore executed **zero** tests; the missing-working-directory error 267 is **not** evidence of a browser crash.
- C: had only 1,341,136,896 bytes free. **Do not redirect browser/XLSX/SQLite stress fixtures or temp files there**.
- The branch now has an additional *unexecuted* safety commit repairing the Python module import from the existing hyphenated `scripts/browser-smoke.py`; no current-SHA Chrome result exists. Always fetch the latest PR head after recovery.
- RELEASE AUTHORIZED=false. No tag, merge, signed release, staging or production deployment.

## A. Read-only diagnosis (PowerShell on the actual Windows machine)

Run in any available **C:** PowerShell session. These commands query devices only; none changes disk configuration:

```powershell
Get-Date
Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,VolumeName,Size,FreeSpace
Get-Disk | Select-Object Number,FriendlyName,SerialNumber,PartitionStyle,OperationalStatus,HealthStatus,IsOffline,Size
Get-PhysicalDisk | Select-Object FriendlyName,SerialNumber,MediaType,OperationalStatus,HealthStatus,Size
Get-Partition | Select-Object DiskNumber,PartitionNumber,DriveLetter,Type,Size
Get-Volume | Select-Object DriveLetter,FileSystemLabel,FileSystemType,HealthStatus,Size,SizeRemaining
Test-Path 'E:\spool-release\qualification\.git'
Test-Path 'E:\spool-release\evidence'
Test-Path 'E:\spool-release\temp\spool-browser-venv\Scripts\python.exe'
```

Also inspect Device Manager, Windows Disk Management (`diskmgmt.msc`), and the physical connection for an external SSD/USB volume, if E: previously referred to one. Capture the device's disk number, serial/label, filesystem and health from Windows; **a drive letter alone is not its identity**.

### Safe interpretations

1. **Disk absent from Get-Disk and Disk Management:** stop automated qualification. If external, check enclosure, connection, power and another port. Do not infer data deletion. If the device stays invisible, involve hardware/data-recovery assistance before writes.
2. **Disk appears but volume/partition missing, RAW, unallocated, needs initialization, or unhealthy:** stop. Do not format, initialize, repair, convert, run `chkdsk /f` or /r, run `diskpart clean`, or automatically create a new partition. Protect evidence and recover the device first.
3. **Identifiable healthy NTFS volume appears at another letter:** compare disk serial, partition/volume label, existing directory names, and data. Do not automatically assign or steal E:; if a letter restoration is needed, get owner approval before using Disk Management.
4. **E: restored:** verify the original worktree, evidence, venv and earlier log files exist, and check for modified/corrupted source. Do not wipe, clone over or run `npm ci` until the current tracked source identity and evidence have been inspected.

## B. Resume only after validated E: restoration

```powershell
if (-not (Test-Path 'E:\spool-release\qualification\.git')) { throw 'STOP: original Git checkout not restored' }
if (-not (Test-Path 'E:\spool-release\evidence')) { throw 'STOP: existing release evidence not restored' }
if (-not (Test-Path 'E:\spool-release\temp\spool-browser-venv\Scripts\python.exe')) { throw 'STOP: browser venv not restored' }
$free = (Get-Volume -DriveLetter E).SizeRemaining
if ($free -lt 10GB) { throw "STOP: E: has insufficient free space for the exact 256 MiB SQLite qualification (10 GiB minimum): $free bytes" }
Set-Location 'E:\spool-release\qualification'
git status --porcelain=v1
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git fetch origin fix/bounded-release-safety-20261011
git log -1 --format='%H %s' origin/fix/bounded-release-safety-20261011
```

If the worktree has uncommitted modifications, stop and have Codex reconcile them. If clean and the expected branch, use `git merge --ff-only origin/fix/bounded-release-safety-20261011`. Do not reset, force, delete untracked evidence, or move to main.

Before invoking the runner, set all temp variables **inside E:** and point to the actual installed Chrome executable. The Python helper is now imported from `browser-smoke.py`; first run the import check, which tests a real import rather than merely compiling syntax.

```powershell
New-Item -ItemType Directory -Force 'E:\spool-release\temp' | Out-Null
$env:TEMP = 'E:\spool-release\temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:SPOOL_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:SPOOL_BROWSER_PYTHON = 'E:\spool-release\temp\spool-browser-venv\Scripts\python.exe'
$env:SPOOL_COMMIT_SHA = (git rev-parse HEAD)
$env:SPOOL_QUALIFICATION_EVIDENCE_ROOT = 'E:\spool-release\evidence'
& $env:SPOOL_BROWSER_PYTHON -c "import importlib.util, pathlib; f=pathlib.Path('scripts/qualify-browser-ui.py').resolve(); s=importlib.util.spec_from_file_location('spool_qualifier',f); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print('QUALIFIER_IMPORT_PASS')"
node scripts/static-check.js
npm ci
npm run build
& $env:SPOOL_BROWSER_PYTHON scripts/qualify-browser-ui.py
```

This runner **has not passed** and may reveal further CDP/UI/Zip errors. Repair observed failures on the review branch and rerun; preserve exact stdout/stderr and resource measurement artifacts on E:.

## C. If E: cannot be recovered

Do **not** treat a new checkout as recovered evidence. A clean Git clone from PR #91 can restore source code to a separately identified physical volume with at least **10 GiB free** for the current SQLite qualifier's mandatory statfs preflight (also covers the browser's separate 3 GiB minimum), with additional verified headroom for snapshots/WAL/fault workloads. Only do so after identifying that volume by actual disk identity and capacity. Historical E: test artifacts, venv and evidence remain inaccessible; report them as unavailable, not deleted, and redo the mandatory gates on the new exact SHA. If the only drive is the current 1.34 GiB-free C:, **STOP** the large qualification jobs. Do not bypass space checks or shrink workloads to fabricate coverage.

## D. Exact next step / stop conditions

- Next step right now: execute the read-only queries in section A and determine whether the missing E: physical device/NTFS partition is visible.
- Never issue automatic `Initialize-Disk`, `Clear-Disk`, `Format-Volume`, `Repair-Volume`, `Set-Partition`, `Set-Disk`, `chkdsk /f`, `diskpart clean`, BitLocker formatting, repartitioning or ACL resets. Never install tools/fixtures on the low-space C: fallback.
- Continue C real Chrome, D 256 MiB SQLite/Windows privacy, native signed exact-SHA release and staging only once the actual volume and scratch preflights are green.
- Maintain PR draft and `RELEASE AUTHORIZED=false`; no GitHub Actions, TinyFish, customer data or production deployment before all mandatory tests and owner authorization.

## E. 13 October 2026 GitHub-only continuation (not machine qualification)

- The review branch received six additional reviewed commits after `a26fd7fd`: per-attempt evidence isolation (`71796f9`), evidence isolation regression (`2ae17b1`), accurate disk prerequisites (`405643f`, `21b2421`), CDP / SPA port ownership guards (`3a5a481`, `be734d3`). Tests were **NOT_EXECUTED** on the resulting branch because this remote GitHub connection cannot run the private checkout on the Windows machine.
- A repeated qualification of the *same Git commit* now stores evidence at `<EVIDENCE_ROOT>/bounded-qualification/<commit-sha>/<unique-attempt-uuid>`, preventing cross-run log/tarball collision. Preserve each attempt independently.
- The original Windows `E:` disappearance remains unresolved in this session. Do not write a replacement worktree to the low-space `C:` drive. Diagnose the physical disk read-only as in section A.
- Read-only authenticated Vercel inspection of the existing `spool-webmcp` production deployment `dpl_UPr6NjpseDybweBRjsk47Qw5P4TR` returned `READY` and a shipped `src/release.json` with commit `61b0c69da2c96aacd091706a5ec266a4eb864721`, built `2026-09-14T05:37:55.043Z` and artifact-root digest `5bd2f35bdcaa28b773ff540460b9962741298b5ebd9685c745fd7d7e6af5289c`. This **does not match** either the reviewed branch or October main; `READY` does not establish tested source parity. No deployment or alias was modified.
- After volume recovery, fetch and fast-forward the isolated review worktree, run real `python -m py_compile scripts/browser-smoke.py scripts/qualify-browser-ui.py`, `node --test tests/qualification-runner.test.js`, `node scripts/static-check.js` and the complete `node scripts/qualify-bounded-release.js`. Capture **new** SHA-bound evidence, do not reuse the historical 482-case results.
- Required unresolved gates: real 49–50 MiB browser CSV/XLSX upload/Worker/reload/export/interaction and adversarial coverage; 256 MiB SQLite sustained load with process-kill/crash/fencing/disk/Windows ACL evidence; all required test skips resolved; installed tarball hash and signed release-chain parity; staged HTTPS identity, Chrome smoke and tested rollback. Preserve `sqlite.target=EXPERIMENTAL`, remote targets excluded and `RELEASE AUTHORIZED=false` until all mandatory gates pass. Never infer a PASS from implementation alone.
