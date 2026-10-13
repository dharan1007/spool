import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { qualificationPlan, assertInstalledPackageEvidence, assertSignedVerificationReceipt } from './qualify-bounded-release.js';
import { loadReleaseChain, verifySignedReleaseEnvelope } from '../src/platform/release-chain.js';
import { fingerprintOfPublicKey } from '../src/platform/signing.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function validatePublicationReport(report, commit, version) {
  const plan = qualificationPlan();
  const required = [...plan.commands, { id: 'security_audit' }, ...plan.requiredRealSurfaces, { id: 'signed_provenance' }].map(x => x.id);
  if (report.status !== 'PASS' || report.commitSha !== commit || report.packageVersion !== version ||
      report.entries?.length !== required.length || new Set(report.entries.map(x => x.id)).size !== required.length ||
      required.some(id => !report.entries.some(x => x.id === id && x.status === 'PASS'))) throw new Error('Complete exact-source qualification is required');
}

export async function preparePublication({ reportPath, commit, version, output, distDir = 'dist',
  parityPath = process.env.SPOOL_PARITY_EVIDENCE || 'release/parity-evidence.json',
  publicKeyPath = process.env.SPOOL_RELEASE_PUBLIC_KEY || 'keys/release-public.key' }) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Publication requires an exact commit');
  if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== commit ||
      execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error('Publication source changed');
  const reportBytes = await readFile(reportPath);
  const report = JSON.parse(reportBytes);
  validatePublicationReport(report, commit, version);
  const evidence = dirname(resolve(reportPath));
  for (const entry of report.entries) {
    if (!entry.log || hash(await readFile(entry.log)) !== entry.logSha256) throw new Error('Qualification log digest mismatch: ' + entry.id);
  }
  const packageLog = await readFile(report.entries.find(x => x.id === 'package').log, 'utf8');
  const packageEvidence = JSON.parse(packageLog.slice(packageLog.lastIndexOf('{')));
  assertInstalledPackageEvidence(packageEvidence, { sha: commit, evidence });
  const chain = await loadReleaseChain({ distDir, commit });
  if (chain.version !== version) throw new Error('Artifact version differs from publication');
  const parityBytes = await readFile(parityPath);
  const envelope = JSON.parse(parityBytes).envelope;
  const publicKey = await readFile(publicKeyPath, 'utf8');
  const payload = verifySignedReleaseEnvelope(envelope, publicKey, { expectedCommit: commit, expectedRoot: chain.artifactRootSha256 });
  if (payload.version !== version) throw new Error('Signed version differs from publication');
  const signed = report.entries.find(x => x.id === 'signed_provenance');
  const signedBytes = await readFile(signed.log);
  const receipt = JSON.parse(signedBytes);
  assertSignedVerificationReceipt(receipt, { sha: commit, version, artifactRootSha256: chain.artifactRootSha256 });
  if (receipt.key !== fingerprintOfPublicKey(publicKey) || signed.key !== receipt.key ||
      signed.commitSha !== commit || signed.version !== version || signed.artifactRootSha256 !== chain.artifactRootSha256 ||
      signed.signatureVerified !== true) throw new Error('Qualification signature identity differs from enrolled key');
  // Exclusive directory creation preserves every earlier publication attempt.
  await mkdir(output);
  const tarball = basename(packageEvidence.tarballPath);
  await copyFile(packageEvidence.tarballPath, join(output, tarball));
  if (hash(await readFile(join(output, tarball))) !== packageEvidence.tarballSha256) throw new Error('Copied package digest changed');
  await writeFile(join(output, 'qualification.json'), reportBytes);
  await writeFile(join(output, 'parity-evidence.json'), parityBytes);
  await writeFile(join(output, 'signature-receipt.json'), signedBytes);
  await copyFile(publicKeyPath, join(output, 'release-public.key'));
  const record = { schemaVersion: 1, product: 'SPOOL', version, tag: `v${version}`, commit,
    artifactRootSha256: chain.artifactRootSha256, key: signed.key,
    artifact: { filename: tarball, sha256: packageEvidence.tarballSha256 },
    qualification: { sha256: hash(reportBytes), evidenceDirectory: evidence },
    supportedScope: { browserStudio: 'Local CSV/XLSX, 50 MiB source, durable recovery, CSV/JSON export',
      localRunner: 'UTF-8 filesystem CSV, existing ordinary SQLite table, INSERT only, 256 MiB source ceiling' },
    excluded: ['PostgreSQL', 'MySQL', 'SQL Server', 'CDC', 'repair', 'cutover', 'destructive writes'] };
  await writeFile(join(output, 'release-record.json'), JSON.stringify(record, null, 2) + '\n');
  const files = [tarball, 'qualification.json', 'parity-evidence.json', 'signature-receipt.json', 'release-public.key', 'release-record.json'];
  const sums = await Promise.all(files.map(async file => `${hash(await readFile(join(output, file)))}  ${file}`));
  await writeFile(join(output, 'SHA256SUMS'), sums.join('\n') + '\n');
  return record;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [reportPath, commit, version, output] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(await preparePublication({ reportPath, commit, version, output })) + '\n');
}
