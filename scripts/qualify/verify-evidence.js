#!/usr/bin/env node
import { join } from 'node:path';
import { verifySha256Sums } from './checksums.js';
import { readFile } from 'node:fs/promises';

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node scripts/qualify/verify-evidence.js <run-dir>');
    process.exit(2);
  }
  try {
    await verifySha256Sums(dir);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    console.log(`Evidence verified: ${dir}`);
    console.log(`Run: ${manifest.qualificationRunId} Profile: ${manifest.profile} Result: ${manifest.result}`);
    console.log(`Files: ${manifest.evidence.files.length} Checksums: OK`);
    if (manifest.dirty) console.log(`Warning: dirty worktree, releaseGrade=false`);
    process.exit(0);
  } catch (e) {
    console.error(`Evidence verification failed: ${e.message}`);
    process.exit(1);
  }
}

main();
