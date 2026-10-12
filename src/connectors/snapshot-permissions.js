import { lstat, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail } from '../core/errors.js';

const execute = promisify(execFile);
// Fixed program: paths are data in the child environment, never PowerShell code.
// Use SIDs rather than localized account names. Protect the directory before
// creating a file, then protect the empty file before its first content write.
const WINDOWS_ACL = `
$ErrorActionPreference = 'Stop'
$path = $env:SPOOL_SNAPSHOT_ACL_PATH
$item = Get-Item -LiteralPath $path -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Snapshot path is a reparse point' }
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($owner.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
if ($env:SPOOL_SNAPSHOT_ACL_APPLY -eq '1') {
  if ($item.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) { throw 'Snapshot path is not owned by the execution principal' }
  if ($item.PSIsContainer) { $acl = New-Object Security.AccessControl.DirectorySecurity }
  else { $acl = New-Object Security.AccessControl.FileSecurity }
  # Change only the DACL. Re-setting an unchanged owner unnecessarily requires
  # WRITE_OWNER, which removable NTFS volumes may not grant to the owner.
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($value in $allowed) {
    $sid = New-Object Security.Principal.SecurityIdentifier($value)
    if ($item.PSIsContainer) {
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
    }
    $acl.AddAccessRule($rule)
  }
  $item.SetAccessControl($acl)
}
$actual = $item.GetAccessControl()
if (-not $actual.AreAccessRulesProtected) { throw 'Snapshot ACL inheritance is enabled' }
if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) { throw 'Snapshot owner differs from the execution principal' }
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $allowed.Count) { throw 'Snapshot ACL has unexpected rules' }
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin $allowed -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Snapshot ACL grants unexpected access' }
}
foreach ($value in $allowed) {
  if (@($rules | Where-Object { $_.IdentityReference.Value -eq $value }).Count -ne 1) { throw 'Snapshot ACL is missing an allowed identity' }
}
`;

export async function assertSnapshotPathUnaliased(path, { directory = false } = {}) {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
    fail('SOURCE_SNAPSHOT_PRIVACY_FAILED', 'Snapshot path must be an unaliased local directory or regular file');
  }
  let ancestor = dirname(absolute);
  while (true) {
    if ((await lstat(ancestor)).isSymbolicLink()) fail('SOURCE_SNAPSHOT_PRIVACY_FAILED', 'Snapshot parent path must not contain a link or junction');
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return info;
}

export async function assertSnapshotParentsUnaliased(path) {
  let ancestor = dirname(resolve(path));
  while (true) {
    try {
      if ((await lstat(ancestor)).isSymbolicLink()) fail('SOURCE_SNAPSHOT_PRIVACY_FAILED', 'Snapshot parent path must not contain a link or junction');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}

async function windowsAcl(path, apply) {
  try {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_ACL, 'utf16le').toString('base64')], {
      env: { ...process.env, SPOOL_SNAPSHOT_ACL_PATH: resolve(path), SPOOL_SNAPSHOT_ACL_APPLY: apply ? '1' : '0' },
      timeout: 30_000, maxBuffer: 128 * 1024, windowsHide: true
    });
  } catch (error) {
    fail('SOURCE_SNAPSHOT_PRIVACY_FAILED', 'Windows snapshot owner-only ACL could not be applied or verified; no snapshot contents may be written or read', { diagnostic: String(error.stderr || error.code || 'ACL process failed').slice(0, 2048) });
  }
}

export async function secureSnapshotPath(path, { directory = false } = {}) {
  await assertSnapshotPathUnaliased(path, { directory });
  if (process.platform === 'win32') await windowsAcl(path, true);
  else await chmod(path, directory ? 0o700 : 0o600);
  await verifySnapshotPrivacy(path, { directory });
}

export async function verifySnapshotPrivacy(path, { directory = false } = {}) {
  const info = await assertSnapshotPathUnaliased(path, { directory });
  if (process.platform === 'win32') await windowsAcl(path, false);
  else if ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    fail('SOURCE_SNAPSHOT_PRIVACY_FAILED', 'Snapshot permissions must permit only the current owner');
  }
}
