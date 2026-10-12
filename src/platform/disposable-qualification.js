import { randomUUID } from 'node:crypto';
import { realpath, writeFile, readFile, lstat } from 'node:fs/promises';
import { join, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fail } from '../core/errors.js';

// Explicit caller-owned setup for disposable qualification only. Creating this
// marker does not qualify a capability or alter the production execution mode.
export async function markDisposableQualification(root) {
  const canonical = await realpath(root);
  const temporary = await realpath(tmpdir());
  if (!canonical.startsWith(temporary + sep) || !/^spool-[A-Za-z0-9_-]+$/.test(basename(canonical)) || (await lstat(root)).isSymbolicLink()) fail('QUALIFICATION_ROOT_INVALID', 'Only a dedicated temporary scratch root may be marked for qualification');
  const path = join(canonical, '.spool-qualification.json');
  const marker = { purpose: 'spool-disposable-qualification-v1', root: canonical, runId: randomUUID() };
  try { await writeFile(path, JSON.stringify(marker), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if ((await lstat(path)).isSymbolicLink()) fail('QUALIFICATION_ROOT_INVALID', 'Qualification marker must not be a link');
    const existing = JSON.parse(await readFile(path, 'utf8'));
    return Object.freeze({ allowExperimental: true, root: canonical, runId: existing.runId });
  }
  return Object.freeze({ allowExperimental: true, root: canonical, runId: marker.runId });
}
