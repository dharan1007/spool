import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

test('package exposes spool binary without registry publication', () => {
  assert.equal(pkg.private, true);
  assert.equal(pkg.bin?.spool, 'src/cli/spool.js');
  assert.ok(Array.isArray(pkg.files));
  for (const required of ['src', 'docs', 'examples', 'LICENSE', 'README.md', 'SECURITY.md', 'ROADMAP.md']) {
    assert.ok(pkg.files.includes(required), `package files must include ${required}`);
  }
});
