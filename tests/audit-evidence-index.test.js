import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertOutputIsNotEvidence,
  buildEvidenceIndex,
  describeEvidenceEntry,
  repositoryRoot,
  serializeEvidenceIndex,
  EVIDENCE_MANIFEST,
  EvidenceIndexError
} from '../scripts/audit-evidence-index.js';

const root = repositoryRoot();
const scriptPath = join(root, 'scripts', 'audit-evidence-index.js');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function temporaryDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function runIndex(args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    ...options
  });
}

test('evidence index inventories real bytes, is deterministic and claims nothing', async () => {
  const first = await buildEvidenceIndex();
  const second = await buildEvidenceIndex();
  const serialized = serializeEvidenceIndex(first);

  assert.equal(serializeEvidenceIndex(second), serialized, 'two runs over unchanged inputs must be byte-identical');
  assert.equal(first.report, 'INTERNAL_AUDIT_READINESS_EVIDENCE_INDEX');
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.attestation, false);
  assert.equal(first.independentAudit, 'NOT_PERFORMED');
  assert.match(first.disclaimer, /not an audit/i);
  assert.match(first.disclaimer, /not a compliance certification/i);
  assert.match(first.disclaimer, /not a signed release/i);
  assert.match(first.disclaimer, /not a production qualification/i);
  assert.doesNotMatch(serialized, /"attestation":\s*true|SOC 2 Type I|"overallScore"|Compliance Score/);

  // No volatile metadata: no timestamps, no absolute machine paths.
  assert.equal(first.generatedAt, undefined);
  assert.equal(first.workingTree, undefined);
  assert.equal(first.commit, undefined, 'commit provenance is opt-in only');
  assert.ok(!serialized.includes(root), 'index must not embed absolute paths');
  assert.doesNotMatch(serialized, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // Sorted, unique, explicitly classified.
  const paths = first.entries.map(entry => entry.path);
  assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(new Set(paths).size, paths.length);
  for (const entry of first.entries) {
    assert.ok(entry.status === 'PRESENT' || entry.status === 'ABSENT', `${entry.path} needs an explicit status`);
    assert.equal(entry.present, entry.status === 'PRESENT');
    assert.ok(EVIDENCE_MANIFEST.some(set => set.id === entry.set), `${entry.path} must belong to a declared set`);
    assert.equal(typeof entry.purpose, 'string');
  }

  assert.equal(first.totals.expected, first.entries.length);
  assert.equal(first.totals.present + first.totals.absent, first.totals.expected);
  assert.equal(first.totals.sets, EVIDENCE_MANIFEST.length);
  assert.ok(first.totals.present >= 30, 'the repository must already hold the core evidence set');
  assert.match(first.indexSha256, /^[0-9a-f]{64}$/);

  for (const entry of first.entries.filter(item => item.status === 'PRESENT').slice(0, 10)) {
    const bytes = await readFile(join(root, entry.path));
    assert.equal(entry.sha256, sha256(bytes), `${entry.path} digest must come from the actual bytes`);
    assert.equal(entry.bytes, bytes.length, `${entry.path} byte length must match the file`);
    const stats = await stat(join(root, entry.path));
    assert.equal(entry.bytes, stats.size);
  }
});

test('expected-but-absent evidence is reported as ABSENT rather than omitted or passed', async () => {
  const index = await buildEvidenceIndex();
  const signedRelease = EVIDENCE_MANIFEST.find(set => set.id === 'signed-release');
  assert.ok(signedRelease?.paths?.length > 0);

  for (const expectedPath of signedRelease.paths) {
    const entry = index.entries.find(item => item.path === expectedPath);
    assert.ok(entry, `${expectedPath} must appear in the index even when it does not exist`);
    assert.equal(entry.status, 'ABSENT');
    assert.equal(entry.present, false);
    assert.equal(entry.sha256, undefined, 'absent evidence must not carry a digest');
    assert.equal(entry.bytes, undefined);
  }

  const present = index.entries.find(item => item.status === 'PRESENT');
  assert.ok(present, 'at least one present entry must exist for the comparison to mean something');
  assert.match(present.sha256, /^[0-9a-f]{64}$/);
});

test('the index refuses to treat its own output as evidence input', async () => {
  assert.throws(() => assertOutputIsNotEvidence(join(root, 'release', 'reproducibility-evidence.json'), root), EvidenceIndexError);
  assert.throws(() => assertOutputIsNotEvidence(join(root, '.console-evidence', 'index.json'), root), EvidenceIndexError);
  assert.throws(() => assertOutputIsNotEvidence(join(root, 'docs', 'compliance', 'soc2', 'index.md'), root), EvidenceIndexError);

  const outside = join(tmpdir(), 'spool-index-out.json');
  assert.equal(assertOutputIsNotEvidence(outside, root), outside);

  // A refusal must leave the evidence file untouched.
  const evidencePath = join(root, 'release', 'reproducibility-evidence.json');
  const before = await readFile(evidencePath);
  const result = runIndex(['--out', evidencePath]);
  assert.equal(result.status, 1, 'writing over evidence must fail');
  assert.match(result.stderr, /EVIDENCE_INDEX_OUTPUT_COLLISION/);
  assert.equal(sha256(await readFile(evidencePath)), sha256(before), 'evidence bytes must be unchanged');
});

test('the index runs from any working directory and never lists its own output', async () => {
  const outDir = await temporaryDirectory('spool-evidence-index-cwd-');
  try {
    const fromRepo = runIndex(['--out', join(outDir, 'from-repo.json')], { cwd: root });
    const fromElsewhere = runIndex(['--out', join(outDir, 'from-elsewhere.json')], { cwd: outDir });
    assert.equal(fromRepo.status, 0, fromRepo.stderr || fromRepo.stdout);
    assert.equal(fromElsewhere.status, 0, fromElsewhere.stderr || fromElsewhere.stdout);

    const repoBytes = await readFile(join(outDir, 'from-repo.json'));
    const elsewhereBytes = await readFile(join(outDir, 'from-elsewhere.json'));
    assert.deepEqual(elsewhereBytes, repoBytes, 'the working directory must not change the index');

    const parsed = JSON.parse(repoBytes.toString('utf8'));
    assert.equal(parsed.entries.some(entry => entry.path.includes('from-repo.json')), false);
    assert.equal(parsed.entries.some(entry => entry.path.includes('from-elsewhere.json')), false);
    assert.match(repoBytes.toString('utf8'), /\n$/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('unexpected read failures are errors, never ABSENT', async () => {
  const fakeRoot = await temporaryDirectory('spool-evidence-index-errors-');
  try {
    // A manifest path that exists but is not a regular file.
    await mkdir(join(fakeRoot, 'release', 'reproducibility-evidence.json'), { recursive: true });
    const set = EVIDENCE_MANIFEST.find(item => item.id === 'release-evidence');
    await assert.rejects(
      () => describeEvidenceEntry(fakeRoot, set, 'release/reproducibility-evidence.json'),
      error => error instanceof EvidenceIndexError && error.code === 'EVIDENCE_INDEX_NOT_A_FILE'
    );

    // Genuine absence in the same fake root is still ABSENT.
    const absent = await describeEvidenceEntry(fakeRoot, set, 'release/parity-evidence.json');
    assert.equal(absent.status, 'ABSENT');

    // Path traversal and absolute paths are refused outright.
    await assert.rejects(() => describeEvidenceEntry(fakeRoot, set, '../outside.json'), /EVIDENCE_INDEX_PATH_TRAVERSAL/);
    await assert.rejects(() => describeEvidenceEntry(fakeRoot, set, 'C:\\Windows\\win.ini'), /EVIDENCE_INDEX_INVALID_PATH/);

    // The same failure aborts the whole build instead of being downgraded to ABSENT.
    await assert.rejects(
      () => buildEvidenceIndex({ root: fakeRoot }),
      error => error instanceof EvidenceIndexError && error.code === 'EVIDENCE_INDEX_NOT_A_FILE'
    );
  } finally {
    await rm(fakeRoot, { recursive: true, force: true });
  }
});

test('opt-in commit provenance is the only caller-supplied field', async () => {
  const commit = 'c5d3cc94b012c80722715375fa409933a316bf1a';
  const index = await buildEvidenceIndex({ commit });
  assert.equal(index.commit, commit);
  assert.equal(serializeEvidenceIndex(index), serializeEvidenceIndex(await buildEvidenceIndex({ commit })));
});
