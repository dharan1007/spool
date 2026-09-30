import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function computeFileSha256(path) {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

export async function writeSha256Sums(dir) {
  const files = (await readdir(dir)).filter(f => f !== 'sha256sums.txt').sort();
  const lines = [];
  for (const file of files) {
    const hash = await computeFileSha256(join(dir, file));
    lines.push(`${hash}  ${file}`);
  }
  const content = lines.join('\n') + '\n';
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'sha256sums.txt'), content, 'utf8');
  return lines;
}

export async function verifySha256Sums(dir) {
  const { readFile } = await import('node:fs/promises');
  const sumsPath = join(dir, 'sha256sums.txt');
  const content = await readFile(sumsPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const [expected, file] = line.split(/\s+/);
    const actual = await computeFileSha256(join(dir, file));
    if (actual !== expected) throw new Error(`Checksum mismatch for ${file}: expected ${expected}, got ${actual}`);
  }
  return true;
}
