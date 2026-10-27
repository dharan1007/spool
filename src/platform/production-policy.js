import { readFileSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { resolve, dirname, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fail, SpoolError } from '../core/errors.js';

// Release-reviewed product scope. Updating the register requires reviewing and
// regenerating this pin from the exact LF bytes in the Git repository; runtime assurance never changes this allowlist.
export const PRODUCTION_POLICY = Object.freeze({
  version: 1, release: '1.1.2',
  matrixSha256: '4915ac015f5b3dbad2896e51a2e3c891d973ad93c8072087ebf64edead00e2a3',
  target: 'sqlite', source: 'filesystem', maxSourceBytes: 10 * 1024 * 1024 * 1024
});
const instances = new WeakSet();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set(['inspect', 'plan', 'dry-run', 'approve', 'run']);

export function verifyProductionPolicy() {
  try {
    const bytes = readFileSync(new URL('../../capabilities/matrix.json', import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== PRODUCTION_POLICY.matrixSha256) fail('POLICY_INTEGRITY_FAILED', 'Capability register does not match the shipped release policy');
    const matrix = JSON.parse(bytes.toString('utf8'));
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    if (matrix.schemaVersion !== 1 || matrix.release !== PRODUCTION_POLICY.release || pkg.version !== PRODUCTION_POLICY.release || !Array.isArray(matrix.capabilities)) fail('POLICY_INTEGRITY_FAILED', 'Capability policy version is missing or stale');
    return matrix;
  } catch (error) {
    if (error instanceof SpoolError) throw error;
    fail('POLICY_INTEGRITY_FAILED', 'Required packaged capability policy cannot be read or validated');
  }
}

function within(root, path) { return path === root || path.startsWith(root + sep); }
function scratchPath(root, path) {
  if (typeof path !== 'string' || !within(root, resolve(path))) fail('QUALIFICATION_ROOT_INVALID', 'Qualification paths must remain inside the marked disposable root');
  let existing = resolve(path);
  while (!existsSync(existing)) existing = dirname(existing);
  if (!within(root, realpathSync(existing))) fail('QUALIFICATION_ROOT_INVALID', 'Qualification path resolves outside its disposable root');
  const info = lstatSync(existing);
  if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) fail('QUALIFICATION_ROOT_INVALID', 'Qualification files cannot alias another filesystem object');
}
function validateQualification(value, paths) {
  if (!value || value.allowExperimental !== true || !UUID.test(value.runId ?? '') || typeof value.root !== 'string') fail('QUALIFICATION_ROOT_INVALID', 'Explicit experimental opt-in, disposable root and run UUID are required');
  const root = realpathSync(value.root);
  const temporary = realpathSync(tmpdir());
  if (!within(temporary, root) || root === temporary || !/^spool-[A-Za-z0-9_-]+$/.test(basename(root)) || lstatSync(value.root).isSymbolicLink()) fail('QUALIFICATION_ROOT_INVALID', 'Qualification root must be a dedicated local scratch directory');
  const markerPath = resolve(root, '.spool-qualification.json');
  if (lstatSync(markerPath).isSymbolicLink()) fail('QUALIFICATION_ROOT_INVALID', 'Qualification marker must be a regular local file');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (marker.purpose !== 'spool-disposable-qualification-v1' || marker.runId !== value.runId || marker.root !== root) fail('QUALIFICATION_ROOT_INVALID', 'Disposable marker is not bound to this root and run');
  for (const path of paths) scratchPath(root, path);
  return root;
}

export function createExecutionPolicy({ qualification = null, sourceRoot, targetRoot, statePath, snapshotRoot, maxSourceBytes = PRODUCTION_POLICY.maxSourceBytes } = {}) {
  verifyProductionPolicy();
  const paths = [sourceRoot, targetRoot, statePath, snapshotRoot];
  let root = null;
  if (qualification !== null) {
    try { root = validateQualification(qualification, paths); }
    catch (error) {
      if (error instanceof SpoolError) throw error;
      fail('QUALIFICATION_ROOT_INVALID', 'Disposable qualification marker or paths cannot be validated');
    }
  }
  if (!root && maxSourceBytes > PRODUCTION_POLICY.maxSourceBytes) fail('PRODUCTION_CAPABILITY_DENIED', 'Production source ceiling exceeds the bounded release policy');
  const policy = Object.freeze({
    mode: root ? 'DISPOSABLE_QUALIFICATION' : 'PRODUCTION',
    assert(operation, input = null) {
      const matrix = verifyProductionPolicy();
      if (root) {
        try { validateQualification(qualification, paths); }
        catch (error) {
          if (error instanceof SpoolError) throw error;
          fail('QUALIFICATION_ROOT_INVALID', 'Disposable qualification context changed');
        }
        for (const [ref, base] of [[input?.sourceRef, sourceRoot], [input?.targetRef, targetRoot]]) {
          if (ref?.path) scratchPath(root, resolve(base, ref.path));
          if (ref?.endpoint) {
            const hostname = new URL(ref.endpoint).hostname;
            if (!['127.0.0.1', '[::1]'].includes(hostname)) fail('QUALIFICATION_ROOT_INVALID', 'Experimental qualification endpoints must be literal loopback addresses');
          }
        }
        return;
      }
      const target = input?.targetRef?.connector;
      const targetStatus = matrix.capabilities.find(item => item.id === `${target}.target`)?.status;
      if (!OPERATIONS.has(operation) || target !== PRODUCTION_POLICY.target || targetStatus !== 'PRODUCTION' ||
          input?.sourceRef?.connector !== PRODUCTION_POLICY.source || input?.writeStrategy?.mode !== 'insert' || input?.writeStrategy?.bulk === true) {
        fail('PRODUCTION_CAPABILITY_DENIED', 'This target or operation is not independently qualified for the bounded production release', { operation, target: target ?? null, maturity: targetStatus ?? 'UNKNOWN' });
      }
      if (!Number.isSafeInteger(input.writeStrategy.batchSize) || input.writeStrategy.batchSize < 1 || input.writeStrategy.batchSize > 10_000) fail('PRODUCTION_CAPABILITY_DENIED', 'Production batch size exceeds the bounded release policy');
    }
  });
  instances.add(policy);
  return policy;
}

export function assertExecutionPolicy(policy) {
  if (!instances.has(policy)) fail('POLICY_INTEGRITY_FAILED', 'Command service requires an authentic shipped execution policy');
}
