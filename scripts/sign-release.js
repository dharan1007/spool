import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fail } from '../src/core/errors.js';
import { signedReleaseEnvelope, loadReleaseChain, verifySignedReleaseEnvelope } from '../src/platform/release-chain.js';
import { fingerprintOfPublicKey } from '../src/platform/signing.js';

function requireEnv(name) {
  const value = process.env[name]?.trim() || '';
  if (!value) fail('MISSING_RELEASE_SECRET', `Environment variable ${name} is required for release signing`);
  return value;
}

function sameEnvelope(existing, chain, publicKey) {
  if (!existing?.envelope?.payload) return false;
  const payload = existing.envelope.payload;
  if (payload.commit !== chain.commit) return false;
  if (payload.artifactRootSha256 !== chain.artifactRootSha256) return false;
  if (existing.envelope.key !== fingerprintOfPublicKey(publicKey)) return false;
  const envelope = existing.envelope ?? existing;
  try {
    verifySignedReleaseEnvelope(envelope, publicKey, {
      expectedCommit: chain.commit,
      expectedRoot: chain.artifactRootSha256
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const distDir = process.env.SPOOL_DIST_DIR?.trim() || 'dist';
  const privateKey = requireEnv('SPOOL_RELEASE_PRIVATE_KEY');
  const version = process.env.SPOOL_RELEASE_VERSION?.trim() || null;
  const outPath = process.env.SPOOL_PARITY_EVIDENCE?.trim() || 'release/parity-evidence.json';
  const outFile = join(process.cwd(), outPath);

  const chain = await loadReleaseChain({ distDir, commit: process.env.EXPECTED_SHA?.trim() || null });
  const publicKey = fingerprintOfPublicKey(privateKeyToPublicPem(privateKey));

  let existing = null;
  try {
    existing = JSON.parse(await readFile(outFile, 'utf8'));
  } catch { /* fresh evidence */ }

  if (existing && sameEnvelope(existing, chain, privateKeyToPublicPem(privateKey))) {
    process.stdout.write(`${JSON.stringify({ pass: true, unchanged: true, commit: chain.commit, artifactRootSha256: chain.artifactRootSha256, key: existing.envelope.key, evidence: outPath })}\n`);
    return;
  }

  const envelope = signedReleaseEnvelope({
    version: version ?? chain.version,
    commit: chain.commit,
    artifactRootSha256: chain.artifactRootSha256,
    generatedAt: new Date().toISOString(),
    privateKey
  });

  const evidence = Object.freeze({
    schemaVersion: 1,
    product: 'SPOOL',
    chain: {
      commit: chain.commit,
      version: chain.version ?? version,
      artifactRootSha256: chain.artifactRootSha256,
      artifactCount: chain.artifactCount
    },
    envelope
  });

  await mkdir(join(process.cwd(), 'release'), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ pass: true, unchanged: false, commit: chain.commit, artifactRootSha256: chain.artifactRootSha256, key: envelope.key, evidence: outPath })}\n`);
}

function privateKeyToPublicPem(privateKey) {
  return createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'pem' });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) await main();