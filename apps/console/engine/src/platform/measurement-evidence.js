import { readFile } from 'node:fs/promises';

/**
 * Read a resource summary emitted by scripts/measure-local-process.py without
 * turning a missing or malformed measurement file into a thrown error. A
 * qualification that fails earlier must report its own failure instead of being
 * masked by an ENOENT from the evidence reader.
 */
export async function readResourceSummary(path) {
  let summary;
  try {
    summary = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return { ok: false, failure: 'resource summary unavailable: ' + (error.code || error.message) };
  }
  if (!summary || !Number.isInteger(summary.samples) || !Array.isArray(summary.errors)) {
    return { ok: false, failure: 'resource summary has invalid shape' };
  }
  if (!summary.samples || summary.errors.length) {
    return { ok: false, failure: 'missing samples or measurement errors', summary };
  }
  return { ok: true, summary };
}
