import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPathPolicy } from '../src/platform/path-policy.js';

test('path policy allows contained paths and rejects traversal and symlink escape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-path-'));
  const root = join(dir, 'allowed');
  const outside = join(dir, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, 'inside.csv'), 'id\n1\n');
  await writeFile(join(outside, 'secret.csv'), 'secret\nnope\n');
  await symlink(outside, join(root, 'escape'));

  try {
    const policy = await createPathPolicy(root);
    assert.equal(await policy.resolve(join(root, 'inside.csv')), await realpath(join(root, 'inside.csv')));
    assert.equal(await policy.resolve(join(root, 'new.db'), { mustExist: false }), join(await realpath(root), 'new.db'));
    await assert.rejects(() => policy.resolve(join(root, '..', 'outside', 'secret.csv')), /PATH_OUTSIDE_ALLOWED_ROOT/);
    await assert.rejects(() => policy.resolve(join(root, 'escape', 'secret.csv')), /PATH_OUTSIDE_ALLOWED_ROOT/);
    await assert.rejects(() => policy.resolve(join(root, 'escape', 'new.db'), { mustExist: false }), /PATH_OUTSIDE_ALLOWED_ROOT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('path policy accepts an allow-root reached through a filesystem alias while still returning canonical paths', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-root-alias-'));
  const actualRoot = join(dir, 'actual');
  const aliasRoot = join(dir, 'alias');
  await mkdir(actualRoot);
  await writeFile(join(actualRoot, 'inside.csv'), 'id\n1\n');
  try {
    try { await symlink(actualRoot, aliasRoot, 'dir'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('Windows runner does not permit directory symlink creation');
        return;
      }
      throw error;
    }
    const policy = await createPathPolicy(aliasRoot);
    assert.equal(await policy.resolve(join(aliasRoot, 'inside.csv')), await realpath(join(actualRoot, 'inside.csv')));
    assert.equal(await policy.resolve(join(aliasRoot, 'new.db'), { mustExist: false }), join(await realpath(actualRoot), 'new.db'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
