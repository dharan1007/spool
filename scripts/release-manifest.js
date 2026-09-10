import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) fail(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${key}`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

const input = args(process.argv.slice(2));
const version = input.version;
const commit = input.commit?.toLowerCase();
const artifactPath = input.artifact ? resolve(input.artifact) : null;
const outPath = input.out ? resolve(input.out) : null;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) fail('version must be a semantic version without a v prefix');
if (!/^[a-f0-9]{40}$/.test(commit || '')) fail('commit must be an exact 40-character Git SHA');
if (!artifactPath) fail('--artifact is required');
if (!outPath) fail('--out is required');

const bytes = await readFile(artifactPath);
const info = await stat(artifactPath);
const artifactSha256 = createHash('sha256').update(bytes).digest('hex');

const record = {
  schemaVersion: 1,
  product: 'SPOOL',
  version,
  tag: `v${version}`,
  commit,
  generatedAt: new Date().toISOString(),
  artifact: {
    filename: basename(artifactPath),
    bytes: info.size,
    sha256: artifactSha256
  },
  supportedScope: {
    browserStudio: 'local-first CSV profiling, deterministic transformation, validation and export; 50 MiB input boundary',
    localRunner: 'UTF-8 filesystem CSV to an existing ordinary SQLite table; INSERT only; customer-local execution',
    transports: ['installed spool CLI', 'loopback-authenticated spoold'],
    evidence: ['source snapshot', 'target contract', 'bound approval', 'fencing', 'atomic batch ledger', 'crash reconciliation', 'row accounting', 'commit-bound receipt']
  },
  explicitlyUnsupported: [
    'hosted raw-row ingestion',
    'PostgreSQL/MySQL production execution in v1.0.0',
    'upsert/replace/delete/truncate',
    'virtual or triggered SQLite targets',
    'legal or regulatory certification'
  ]
};

await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
