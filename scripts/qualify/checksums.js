import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SUMS_FILE = 'sha256sums.txt';
const EVIDENCE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const SUM_LINE = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,254})$/;

function requireFileName(name) {
  if (!EVIDENCE_FILENAME.test(name) || name === '.' || name === '..' || name === SUMS_FILE) {
    throw new Error(`Invalid evidence file name: ${String(name)}`);
  }
  return name;
}

async function listedEvidenceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isFile()) throw new Error(`Non-regular evidence entry: ${entry.name}`);
    if (entry.name !== SUMS_FILE) names.push(requireFileName(entry.name));
  }
  return names.sort();
}

// Stream the input: an industrial evidence bundle may contain multi-gigabyte
// raw event logs, and verification must not materialize them in heap memory.
export async function computeFileSha256(path) {
  // Pin the file descriptor before hashing: a symlink swap between lstat
  // and createReadStream must never change which inode is authenticated.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`Not a regular evidence file: ${path}`);
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally { await file.close(); }
}

export async function writeSha256Sums(dir) {
  const files = await listedEvidenceFiles(dir);
  const lines = [];
  for (const file of files) {
    const hash = await computeFileSha256(join(dir, file));
    lines.push(`${hash}  ${file}`);
  }
  await writeFile(join(dir, SUMS_FILE), `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return lines;
}

// Verify EXACT coverage, not just each checksum line that happens to exist.
// An omitted line was previously sufficient to leave an evidence file wholly
// unverified while the manifest still pinned only the file NAME.
export async function verifySha256Sums(dir) {
  const sumsPath = join(dir, SUMS_FILE);
  const sumsInfo = await lstat(sumsPath);
  if (!sumsInfo.isFile() || sumsInfo.isSymbolicLink()) throw new Error('Checksum index must be a regular file');
  const content = await readFile(sumsPath, 'utf8');
  if (!content.endsWith('\n')) throw new Error('Checksum index lacks canonical final newline');
  const lines = content.slice(0, -1).split('\n');
  const listed = await listedEvidenceFiles(dir);
  if (lines.length !== listed.length) {
    throw new Error(`Checksum coverage mismatch: ${lines.length} entries for ${listed.length} evidence files`);
  }
  for (let i = 0; i < lines.length; i += 1) {
    const match = SUM_LINE.exec(lines[i]);
    if (!match) throw new Error(`Invalid checksum record at line ${i + 1}`);
    const [, expected, file] = match;
    if (file !== listed[i]) throw new Error(`Checksum order/coverage mismatch at line ${i + 1}: ${file} vs ${listed[i]}`);
    const actual = await computeFileSha256(join(dir, file));
    if (actual !== expected) throw new Error(`Checksum mismatch for ${file}: expected ${expected}, got ${actual}`);
  }
  return true;
}
