#!/usr/bin/env node
// Offline receipt verification: recompute the content identity from the
// envelope record and verify the detached Ed25519 signature against local
// PEM trust roots. No daemon, no network, no database.
//
// Usage:
//   node scripts/verify-receipt.js <receipt.json> --trust-root <key.pem> [--trust-root <key2.pem> ...]
import { readFile } from 'node:fs/promises';
import { verifySignedReceiptEnvelope } from '../src/execution/receipt.js';
import { publicKeyId } from '../src/platform/signing.js';

function usage() {
  console.error('Usage: node scripts/verify-receipt.js <receipt.json> --trust-root <key.pem> [--trust-root ...]');
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const roots = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--trust-root' && args[i + 1]) roots.push(args[++i]);
  }
  if (!file || roots.length === 0) usage();
  let envelope;
  try {
    envelope = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    console.error(`Receipt verification failed: cannot read ${file}: ${e.message}`);
    process.exit(1);
  }
  const trustRoots = [];
  for (const path of roots) {
    try {
      const pem = await readFile(path, 'utf8');
      trustRoots.push({ keyId: publicKeyId(pem), publicKey: pem });
    } catch (e) {
      console.error(`Receipt verification failed: cannot read trust root ${path}: ${e.message}`);
      process.exit(1);
    }
  }
  try {
    const result = verifySignedReceiptEnvelope(envelope, { trustRoots });
    console.log(`Receipt authentic: ${result.receiptId} (key ${result.keyId})`);
    process.exit(0);
  } catch (e) {
    console.error(`Receipt verification failed: ${e.code ?? 'UNKNOWN'}: ${e.message}`);
    process.exit(1);
  }
}

main();
