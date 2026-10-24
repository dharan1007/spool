# Windows-first behaviour

## Assumptions

SPOOL Console targets Windows 10/11 x64 first. Everything is exercised on
Windows during release preparation; other platforms are untested and are not
qualified by this release.

## Windows-specific facts

- **Paths**: source/target roots are resolved with the engine path policy on
  NT paths; UNC and mapped-drive paths work only if they resolve below the
  migration `sourceRoot`/`targetRoot`.
- **DPAPI**: the approval key uses `safeStorage`, which on Windows is DPAPI
  scoped to the Windows user. Consequences (verified during packaging):
  - the key (and therefore its approvals) does not transfer across machines;
  - a key created by the development Electron build cannot be decrypted by the
    packaged app identity and vice versa - both fail closed;
  - `%APPDATA%\SPOOL Console` also holds `console-meta.db`; moving it between
    profiles does not carry the key.
- **Shell integration**: the packaged launcher is
  `dist\package\win-unpacked\SPOOL Console.exe` (unsigned). SmartScreen may
  warn on double-click; for internal distribution see PACKAGING.md.
- **Console encoding**: the renderer enforces UTF-8; the Windows console
  (PowerShell 5.1) historical code pages do not affect the app, only developer
  scripts.

## Powershell 5.1 developer notes

The developer tooling on this machine must assume PowerShell 5.1 constraints:

- no `&&` / `||`, no bash heredocs, no `head`/`tail`/`grep`;
- heredoc pattern `@'…'@ | Set-Content`;
- UTF-8 without BOM matters for JSON parsed by Vite; write with
  `[IO.File]::WriteAllText(path, text, UTF8Encoding($false))`.

## Not evaluated on Windows here (honesty note)

- Windows Hello / enterprise DPAPI policies (machine keys) — defaulted to
  user-scope DPAPI, which is the platform default.
- Roaming profiles / folder redirection — `%APPDATA%` was used, no exotic
  redirection was tested.
