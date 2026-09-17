import { writeFile, mkdir } from 'node:fs/promises';
import { generateSigningKeyPair } from '../src/platform/signing.js';

const { publicKey, privateKey } = generateSigningKeyPair();
await mkdir('keys', { recursive: true });
await writeFile('keys/release-public.key', `${publicKey}\n`, 'utf8');
process.stdout.write(`Public key written to keys/release-public.key (${publicKey.slice(0, 16)}...)\n`);
process.stdout.write(`Private key (set SPOOL_RELEASE_PRIVATE_KEY and delete these bytes from history):\n${privateKey}\n`);