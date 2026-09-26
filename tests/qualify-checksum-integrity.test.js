import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeFileSha256, writeSha256Sums, verifySha256Sums } from '../scripts/qualify/checksums.js';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-evidence-checks-'));
  try {
    await writeFile(join(dir, 'manifest.json'), '{}');
    await writeFile(join(dir, 'metrics.json'), '{"ok":true}');
    await writeSha256Sums(dir);
    await fn(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('valid complete checksums verify', async () => fixture(async dir => {
  assert.equal(await verifySha256Sums(dir), true);
  assert.equal((await computeFileSha256(join(dir, 'manifest.json'))).length, 64);
}));

test('delete an index entry: fail closed', async () => fixture(async dir => {
  const f = join(dir, 'sha256sums.txt');
  const lines = (await readFile(f, 'utf8')).trimEnd().split('\n');
  await writeFile(f, `${lines.slice(0, -1).join('\n')}\n`);
  await assert.rejects(verifySha256Sums(dir), /coverage mismatch/);
}));

test('duplicate a checksum entry: fail closed', async () => fixture(async dir => {
  const f = join(dir, 'sha256sums.txt');
  const lines = (await readFile(f, 'utf8')).trimEnd().split('\n');
  await writeFile(f, `${lines.join('\n')}\n${lines[0]}\n`);
  await assert.rejects(verifySha256Sums(dir), /coverage mismatch/);
}));

test('a new evidence file omitted from checksums fails', async () => fixture(async dir => {
  await writeFile(join(dir, 'unlisted.json'), '{}');
  await assert.rejects(verifySha256Sums(dir), /coverage mismatch/);
}));

test('tampered evidence data fails', async () => fixture(async dir => {
  await writeFile(join(dir, 'metrics.json'), '{"ok":false}');
  await assert.rejects(verifySha256Sums(dir), /Checksum mismatch/);
}));

test('traversal and malformed names in index fail', async () => fixture(async dir => {
  const f = join(dir, 'sha256sums.txt');
  const content = await readFile(f, 'utf8');
  await writeFile(f, content.replace('manifest.json', '../manifest.json'));
  await assert.rejects(verifySha256Sums(dir), /Invalid checksum record/);
}));

test('symlink substitution fails even if the checksum could match', async () => fixture(async dir => {
  await rm(join(dir, 'metrics.json'));
  await symlink(join(dir, 'manifest.json'), join(dir, 'metrics.json'));
  await assert.rejects(verifySha256Sums(dir), /Non-regular evidence entry/);
}));

test('checksum index requires canonical newline and unique file-set', async () => fixture(async dir => {
  const f = join(dir, 'sha256sums.txt');
  const content = await readFile(f, 'utf8');
  await writeFile(f, content.trimEnd());
  await assert.rejects(verifySha256Sums(dir), /final newline/);
}));
