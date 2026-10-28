#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Internal audit-readiness evidence inventory.
 *
 * Produces a deterministic, content-hashed manifest of the evidence SPOOL keeps
 * in the repository (registers, security design documents, internal compliance
 * mapping, release evidence, generated suite evidence, benchmark summary) so a
 * third party can be handed a manifest instead of a directory listing.
 *
 * It is NOT an audit, NOT an attestation, NOT a compliance certification, NOT a
 * signed release and NOT a production qualification. Nothing here closes
 * BLOCKERS.json B004.
 *
 * Guarantees, in order:
 * - input scope is an explicit allowlist (no recursive sweep of the repo, no
 *   keys/credentials/temporary directories/unrelated files);
 * - only git-tracked files are inventoried, so the manifest describes the
 *   repository rather than one machine's leftover build output. Files that
 *   exist locally but are not tracked are listed separately under `localOnly`
 *   and excluded from the manifest digest;
 * - every present file is hashed from its actual bytes;
 * - expected-but-absent evidence is reported as ABSENT, never omitted and never
 *   implied to have passed;
 * - unexpected read failures abort the run instead of being reported as ABSENT;
 * - the output is byte-identical for unchanged inputs (no timestamps, no
 *   absolute paths, no environment values);
 * - the index cannot include itself: an output path that collides with the
 *   evidence scope is refused.
 */

export const SCHEMA_VERSION = 1;

export const INDEX_DISCLAIMER =
  'Evidence inventory only. Not an audit, not a compliance certification, not a signed release ' +
  'and not a production qualification. No independent auditor has reviewed these artifacts. ' +
  'An ABSENT entry means the artifact does not exist in this working tree; it is never implied to exist.';

export const EVIDENCE_MANIFEST = Object.freeze([
  {
    id: 'completion-registers',
    kind: 'register',
    purpose: 'Durable engineering state: requirements, tasks, blockers, test results, resume instructions, qualification report',
    paths: [
      'engineering/completion/MASTER_REQUIREMENTS.json',
      'engineering/completion/CURRENT_STATE.json',
      'engineering/completion/REMAINING_TASKS.json',
      'engineering/completion/TEST_RESULTS.json',
      'engineering/completion/BLOCKERS.json',
      'engineering/completion/RESUME.md',
      'engineering/completion/PRODUCTION_QUALIFICATION.md',
      'engineering/completion/CAPACITY_RELOCATION.md'
    ]
  },
  {
    id: 'security-design',
    kind: 'design',
    purpose: 'Threat model, limits, dependency risk, deployment and architecture documents the security work is assessed against',
    paths: [
      'docs/THREAT_MODEL.md',
      'docs/LIMITS.md',
      'docs/PRODUCTION_AUDIT.md',
      'docs/DEPENDENCY_RISK.md',
      'docs/SELF_HOSTING.md',
      'docs/WEBMCP.md',
      'docs/ARCHITECTURE.md',
      'docs/BENCHMARKS.md'
    ]
  },
  {
    id: 'compliance-mapping',
    kind: 'policy',
    purpose: 'Internal control documents mapped to the SOC 2 Trust Services Criteria; internal mapping, not an audit',
    dir: 'docs/compliance/soc2',
    extension: '.md'
  },
  {
    id: 'release-evidence',
    kind: 'evidence',
    purpose: 'Release-chain evidence that is generated locally by the build and qualification commands',
    paths: ['release/parity-evidence.json', 'release/reproducibility-evidence.json']
  },
  {
    id: 'signed-release',
    kind: 'evidence',
    purpose:
      'Artifacts that exist only after an authorized signed release. They are absent until release signing material exists (BLOCKERS B003); an unsigned local build produces dist/release-manifest.json instead, which is build output and is deliberately not inventoried here',
    paths: ['release/release-manifest.json', 'release/release-chain.json']
  },
  {
    id: 'generated-evidence',
    kind: 'evidence',
    purpose: 'Evidence emitted by executed suites (internal control self-assessment, API stress, cloud wire staging, qualification runs)',
    dir: '.console-evidence',
    extension: '.json'
  },
  {
    id: 'benchmark-evidence',
    kind: 'evidence',
    purpose: 'Latest deterministic benchmark summary for the qualified commit',
    paths: ['benchmarks/latest.json']
  }
]);

export class EvidenceIndexError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'EvidenceIndexError';
    this.code = code;
  }
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LOCAL_ONLY_NOTE =
  'Present in this working tree but not tracked by git (gitignored local build output or generated evidence). ' +
  'Excluded from `entries` and from `indexSha256` so the manifest describes the repository rather than one machine.';

export function repositoryRoot() {
  return REPO_ROOT;
}

function normalizeRelativePath(value) {
  return value.split(sep).join('/');
}

function assertRepositoryRelative(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new EvidenceIndexError('EVIDENCE_INDEX_INVALID_PATH', 'manifest paths must be non-empty strings');
  }
  if (isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.startsWith('\\\\')) {
    throw new EvidenceIndexError('EVIDENCE_INDEX_INVALID_PATH', `${relativePath} must be repository-relative`);
  }
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.split('/').some(segment => segment === '..' || segment === '.')) {
    throw new EvidenceIndexError('EVIDENCE_INDEX_PATH_TRAVERSAL', `${relativePath} must not traverse outside the repository`);
  }
  return normalized;
}

function expandSet(set, root) {
  const files = (set.paths ?? []).map(assertRepositoryRelative);
  if (set.dir) {
    const directory = assertRepositoryRelative(set.dir);
    const absolute = join(root, directory);
    if (existsSync(absolute)) {
      const names = readdirSync(absolute, { withFileTypes: true })
        .filter(entry => entry.isFile() && (!set.extension || entry.name.endsWith(set.extension)))
        .map(entry => `${directory}/${entry.name}`);
      files.push(...names.map(assertRepositoryRelative).sort());
    }
  }
  return files;
}

/**
 * Ask git which of the candidate paths are tracked. The manifest must describe
 * the repository, so a git work tree is required; there is no silent fallback
 * to "whatever happens to be on disk".
 */
export function gitTrackedPaths(root, candidates) {
  if (candidates.length === 0) return new Set();
  let output;
  try {
    output = execFileSync('git', ['ls-files', '-z', '--', ...candidates], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    throw new EvidenceIndexError(
      'EVIDENCE_INDEX_GIT_REQUIRED',
      `${root} is not a usable git work tree (${error?.code ?? error?.message ?? error}); a git checkout is required to decide which evidence is tracked`
    );
  }
  return new Set(
    output
      .split('\0')
      .filter(Boolean)
      .map(entry => normalizeRelativePath(entry))
  );
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Describe one manifest entry. Absence (ENOENT) is a recorded status; every other
 * failure is raised so it cannot masquerade as missing evidence.
 */
export async function describeEvidenceEntry(root, set, relativePath) {
  const path = assertRepositoryRelative(relativePath);
  const absolute = resolve(root, path);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolute !== resolve(root) && !absolute.startsWith(rootWithSep)) {
    throw new EvidenceIndexError('EVIDENCE_INDEX_PATH_TRAVERSAL', `${path} resolves outside ${root}`);
  }

  const base = { path, set: set.id, kind: set.kind, purpose: set.purpose };
  let stats;
  try {
    stats = statSync(absolute);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ...base, status: 'ABSENT', present: false };
    }
    throw new EvidenceIndexError('EVIDENCE_INDEX_READ_FAILED', `${path} could not be inspected (${error?.code ?? error?.message ?? error})`);
  }

  if (!stats.isFile()) {
    throw new EvidenceIndexError('EVIDENCE_INDEX_NOT_A_FILE', `${path} exists but is not a regular file`);
  }

  let bytes;
  try {
    bytes = await readFile(absolute);
  } catch (error) {
    throw new EvidenceIndexError('EVIDENCE_INDEX_READ_FAILED', `${path} could not be read (${error?.code ?? error?.message ?? error})`);
  }

  return {
    ...base,
    status: 'PRESENT',
    present: true,
    bytes: bytes.length,
    sha256: digest(bytes)
  };
}

/**
 * Refuse an output path that would become index input on a later run, which would
 * make the index self-referential and non-deterministic.
 */
export function assertOutputIsNotEvidence(outputPath, root) {
  const absolute = resolve(outputPath);
  const relativeOutput = normalizeRelativePath(relative(root, absolute));
  if (relativeOutput.startsWith('../') || relativeOutput === '..' || isAbsolute(relativeOutput)) {
    return absolute;
  }
  for (const set of EVIDENCE_MANIFEST) {
    for (const configured of set.paths ?? []) {
      if (normalizeRelativePath(configured) === relativeOutput) {
        throw new EvidenceIndexError(
          'EVIDENCE_INDEX_OUTPUT_COLLISION',
          `refusing to write the index over evidence file ${relativeOutput}`
        );
      }
    }
    if (set.dir) {
      const directory = normalizeRelativePath(set.dir);
      const prefix = `${directory}/`;
      const insideDirectory = relativeOutput.startsWith(prefix) && !relativeOutput.slice(prefix.length).includes('/');
      const matchesExtension = !set.extension || relativeOutput.endsWith(set.extension);
      if (insideDirectory && matchesExtension) {
        throw new EvidenceIndexError(
          'EVIDENCE_INDEX_OUTPUT_COLLISION',
          `refusing to write the index inside the ${set.id} evidence directory (${relativeOutput})`
        );
      }
    }
  }
  return absolute;
}

export async function buildEvidenceIndex({ root = REPO_ROOT, commit, trackedPaths } = {}) {
  const rootPath = resolve(root);

  const declared = [];
  for (const set of EVIDENCE_MANIFEST) {
    for (const relativePath of expandSet(set, rootPath)) {
      declared.push({ set, path: relativePath });
    }
  }
  declared.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const tracked =
    trackedPaths === undefined
      ? gitTrackedPaths(rootPath, declared.map(item => item.path))
      : new Set([...trackedPaths].map(assertRepositoryRelative));

  const entries = [];
  const localOnly = [];
  for (const { set, path } of declared) {
    if (!tracked.has(path) && existsSync(resolve(rootPath, path))) {
      // Untracked and present: local build output, not repository evidence.
      localOnly.push(path);
      continue;
    }
    entries.push(await describeEvidenceEntry(rootPath, set, path));
  }

  if (entries.length === 0) {
    throw new EvidenceIndexError('EVIDENCE_INDEX_EMPTY', 'the evidence manifest resolved to zero entries');
  }

  const index = {
    report: 'INTERNAL_AUDIT_READINESS_EVIDENCE_INDEX',
    schemaVersion: SCHEMA_VERSION,
    attestation: false,
    independentAudit: 'NOT_PERFORMED',
    disclaimer: INDEX_DISCLAIMER,
    scope: {
      root: 'repository root (resolved from the script location, not the caller working directory)',
      manifest: 'explicit allowlist: registers, security design documents, internal compliance mapping, release evidence, generated suite evidence, benchmark summary',
      tracked: 'git-tracked files only, so the manifest is identical in a fresh clone of the same commit',
      excludes: [
        'credentials, keys and any .env file',
        'temporary directories and build output such as dist/',
        'untracked or gitignored files present in the working tree (listed under localOnly instead)',
        'unrelated project data and unlisted repository files',
        'the index output itself'
      ],
      selfReference: 'refused: an output path equal to a manifest file or inside a manifest directory is rejected'
    },
    totals: {
      expected: entries.length,
      present: entries.filter(entry => entry.status === 'PRESENT').length,
      absent: entries.filter(entry => entry.status === 'ABSENT').length,
      localOnly: localOnly.length,
      sets: EVIDENCE_MANIFEST.length
    },
    indexSha256: digest(
      Buffer.from(entries.map(entry => `${entry.path}:${entry.status}:${entry.sha256 ?? 'ABSENT'}`).join('\n'), 'utf8')
    ),
    localOnly: { note: LOCAL_ONLY_NOTE, paths: localOnly },
    entries
  };
  if (commit) index.commit = commit;
  return index;
}

export function serializeEvidenceIndex(index) {
  return `${JSON.stringify(index, null, 2)}\n`;
}

function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const invokedFromCli = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false;
if (invokedFromCli) {
  const outPath = argumentValue(process.argv, '--out');
  const commit = argumentValue(process.argv, '--commit');
  Promise.resolve()
    .then(async () => {
      const index = await buildEvidenceIndex({ commit });
      const serialized = serializeEvidenceIndex(index);
      if (outPath) {
        assertOutputIsNotEvidence(outPath, REPO_ROOT);
        const absoluteOut = resolve(outPath);
        await mkdir(dirname(absoluteOut), { recursive: true });
        await writeFile(absoluteOut, serialized, 'utf8');
      } else {
        process.stdout.write(serialized);
      }
      const { totals } = index;
      console.error(
        `Evidence index: ${totals.present}/${totals.expected} tracked entries present, ${totals.absent} absent (recorded as ABSENT), ` +
          `${totals.localOnly} untracked local file(s) excluded. Not an audit, not a compliance certification, not a signed release, ` +
          'not a production qualification.'
      );
      if (totals.absent > 0) {
        console.error(
          `ABSENT: ${index.entries.filter(entry => entry.status === 'ABSENT').map(entry => entry.path).join(', ')}`
        );
      }
      process.exit(0);
    })
    .catch(error => {
      console.error(error?.message ?? error);
      process.exit(1);
    });
}
