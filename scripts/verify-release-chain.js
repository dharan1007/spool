import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fail } from '../src/core/errors.js';
import { loadReleaseChain, verifySignedReleaseEnvelope } from '../src/platform/release-chain.js';
import { fingerprintOfPublicKey } from '../src/platform/signing.js';

const PARITY_DOMAIN = 'release-parity-v1';

async function main() {
  const distDir = process.env.SPOOL_DIST_DIR?.trim() || 'dist';
  const expectedCommit = process.env.EXPECTED_SHA?.trim() || null;
  const publicKeyPath = process.env.SPOOL_RELEASE_PUBLIC_KEY?.trim() || 'keys/release-public.key';
  const evidencePath = process.env.SPOOL_PARITY_EVIDENCE?.trim() || null;

  const chain = await loadReleaseChain({ distDir, commit: expectedCommit });
  const publicKey = (await readFile(publicKeyPath, 'utf8')).trim();

  if (evidencePath) {
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    const envelope = evidence.envelope ?? evidence;
    if (envelope.payload?.domain !== PARITY_DOMAIN && envelope.domain !== PARITY_DOMAIN) {
      fail('RELEASE_ENVELOPE_DOMAIN', 'Parity envelope must use the release-parity-v1 domain');
    }
    verifySignedReleaseEnvelope(envelope, publicKey, {
      expectedCommit: expectedCommit ?? undefined,
      expectedRoot: chain.artifactRootSha256
    });
  }

  const fingerprint = fingerprintOfPublicKey(publicKey);
  process.stdout.write(`${JSON.stringify({ pass: true, commit: chain.commit, version: chain.version, artifactRootSha256: chain.artifactRootSha256, artifactCount: chain.artifactCount, key: fingerprint, signatureVerified: Boolean(evidencePath) })}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) await main();