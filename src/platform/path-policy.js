import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { fail } from '../core/errors.js';

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertContained(root, candidate) {
  if (!contained(root, candidate)) {
    fail('PATH_OUTSIDE_ALLOWED_ROOT', 'Filesystem path resolves outside the configured allow-root', { root, candidate });
  }
}

function assertLexicallyContained(lexicalRoot, canonicalRoot, candidate) {
  if (!contained(lexicalRoot, candidate) && !contained(canonicalRoot, candidate)) {
    fail('PATH_OUTSIDE_ALLOWED_ROOT', 'Filesystem path resolves outside the configured allow-root', {
      root: lexicalRoot,
      canonicalRoot,
      candidate
    });
  }
}

async function canonicalProspectivePath(canonicalRoot, candidate) {
  let cursor = candidate;
  const suffix = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      assertContained(canonicalRoot, existing);
      return suffix.reduceRight((base, part) => join(base, part), existing);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) fail('PATH_OUTSIDE_ALLOWED_ROOT', 'No contained existing ancestor could be resolved');
      suffix.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

export async function createPathPolicy(rootPath) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) fail('INVALID_PATH_POLICY', 'Allow-root must be a non-empty path');
  const lexicalRoot = resolve(rootPath);
  const root = await realpath(lexicalRoot);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) fail('INVALID_PATH_POLICY', 'Allow-root must resolve to a directory');

  return Object.freeze({
    root,
    async resolve(candidatePath, { mustExist = true } = {}) {
      if (typeof candidatePath !== 'string' || !candidatePath.trim()) fail('INVALID_PATH', 'Candidate path must be a non-empty string');
      const lexical = isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(lexicalRoot, candidatePath);
      assertLexicallyContained(lexicalRoot, root, lexical);
      if (mustExist) {
        let actual;
        try { actual = await realpath(lexical); }
        catch (error) {
          if (error?.code === 'ENOENT') fail('PATH_NOT_FOUND', 'Filesystem path does not exist', { path: lexical });
          throw error;
        }
        assertContained(root, actual);
        return actual;
      }
      const actual = await canonicalProspectivePath(root, lexical);
      assertContained(root, actual);
      return actual;
    }
  });
}
