import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMigrationReceipt,
  createRepairReceipt,
  signReceiptEnvelope,
  verifySignedReceiptEnvelope
} from '../src/execution/receipt.js';
import { generateSigningKeyPair, publicKeyId } from '../src/platform/signing.js';

const input = () => ({
  release: { version: '1.0.0', commitSha: '0123456789abcdef0123456789abcdef01234567' },
  migrationId: 'mig_receipt_001',
  planId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sourceSnapshotId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  targetIdentity: { connector: 'sqlite', connectionId: 'dst', resource: 'customers', path: '/srv/spool/customers.db', secretRef: { provider: 'env', key: 'DB_PASSWORD' } },
  batchIdentities: ['sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'],
  counts: { sourceRows: 10, writtenRows: 9, rejectedRows: 1, filteredRows: 0 },
  violationsSummary: [{ code: 'INVALID_DATE', count: 1 }],
  verification: { status: 'VERIFIED', accounting: { unexplainedRows: 0 }, ledger: { complete: true } },
  startedAt: '2026-09-09T10:00:00.000Z',
  completedAt: '2026-09-09T10:01:00.000Z'
});

test('receipt hash is deterministic, semantic, and excludes secret references', () => {
  const a = createMigrationReceipt(input());
  const bInput = input();
  bInput.counts = { filteredRows: 0, rejectedRows: 1, writtenRows: 9, sourceRows: 10 };
  const b = createMigrationReceipt(bInput);
  assert.equal(a.receiptId, b.receiptId);
  assert.match(a.receiptId, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(a), /DB_PASSWORD|secretRef/);

  const changed = input();
  changed.counts.writtenRows = 8;
  assert.notEqual(createMigrationReceipt(changed).receiptId, a.receiptId);
});

const repairInput = () => ({
  release: { version: '1.0.0', commitSha: '0123456789abcdef0123456789abcdef01234567' },
  migrationId: 'mig_repair_receipt_001',
  repairApprovalId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  repairPlanIds: ['sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
  planId: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  sourceSnapshotId: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  targetIdentity: { connector: 'postgres', connectionId: 'dst', resource: 'public.orders' },
  targetContractId: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  opCounts: { insert: 1, update: 2, delete: 0, alreadyApplied: 1 },
  verification: { status: 'VERIFIED', level: 'CONTENT_EXACT', rowCount: 5, rootHash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
  startedAt: '2026-09-09T10:00:00.000Z',
  completedAt: '2026-09-09T10:02:00.000Z'
});

test('repair receipt is deterministic and bound to the repair approval, plans and re-verification', () => {
  const a = createRepairReceipt(repairInput());
  const b = createRepairReceipt(repairInput());
  assert.equal(a.receiptId, b.receiptId);
  assert.match(a.receiptId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(a.record.kind, 'repair');

  const changed = repairInput();
  changed.opCounts = { insert: 1, update: 1, delete: 0, alreadyApplied: 2 };
  assert.notEqual(createRepairReceipt(changed).receiptId, a.receiptId);
});

test('repair receipt requires exact re-verification and a bound approval identity', () => {
  const unverified = repairInput();
  unverified.verification = { status: 'DIFF' };
  assert.throws(() => createRepairReceipt(unverified), /REPAIR_RECEIPT_REQUIRES_REVERIFICATION/);

  const unapproved = repairInput();
  delete unapproved.repairApprovalId;
  assert.throws(() => createRepairReceipt(unapproved), /INVALID_RECEIPT_INPUT/);

  const unplanned = repairInput();
  unplanned.repairPlanIds = [];
  assert.throws(() => createRepairReceipt(unplanned), /INVALID_REPAIR_RECEIPT_INPUT/);
});

test('signed receipts verify offline and every semantic tamper fails', () => {
  const receipt = createMigrationReceipt(input());
  const keys = generateSigningKeyPair();
  const keyId = publicKeyId(keys.publicKey);
  const envelope = signReceiptEnvelope({ receipt, privateKey: keys.privateKey });
  assert.equal(envelope.kind, 'spool-signed-receipt-v1');
  assert.equal(envelope.signature.keyId, keyId);
  assert.equal(envelope.signature.domain, 'spool-receipt-signature-v1');
  const trustRoots = [{ keyId, publicKey: keys.publicKey }];
  const verified = verifySignedReceiptEnvelope(envelope, { trustRoots });
  assert.equal(verified.authentic, true);
  assert.equal(verified.receiptId, receipt.receiptId);

  // Claimed keyId must match the actual signing key.
  const other = generateSigningKeyPair();
  assert.throws(
    () => signReceiptEnvelope({ receipt, privateKey: keys.privateKey, keyId: publicKeyId(other.publicKey) }),
    /KEY_FINGERPRINT_MISMATCH/
  );
  // Untrusted keys fail closed.
  assert.throws(
    () => verifySignedReceiptEnvelope(envelope, { trustRoots: [{ keyId: publicKeyId(other.publicKey), publicKey: other.publicKey }] }),
    /RECEIPT_KEY_UNTRUSTED/
  );
  // Record tamper breaks the content identity before signature checks.
  const edited = structuredClone(envelope);
  edited.record.counts.writtenRows += 1;
  assert.throws(() => verifySignedReceiptEnvelope(edited, { trustRoots }), /RECEIPT_IDENTITY_MISMATCH/);
  // ReceiptId swap breaks the binding.
  const swapped = structuredClone(envelope);
  swapped.receiptId = createMigrationReceipt({ ...input(), migrationId: 'mig_receipt_002' }).receiptId;
  assert.throws(() => verifySignedReceiptEnvelope(swapped, { trustRoots }), /RECEIPT_IDENTITY_MISMATCH/);
  // Signature tamper fails.
  const reSigned = structuredClone(envelope);
  reSigned.signature.signature = Buffer.from('tampered-signature-payload').toString('base64url');
  assert.throws(() => verifySignedReceiptEnvelope(reSigned, { trustRoots }), /RECEIPT_SIGNATURE_INVALID/);
  // Retired keys keep verifying: rotation appends, never rewrites history.
  const rotated = generateSigningKeyPair();
  const rotatedRoots = [...trustRoots, { keyId: publicKeyId(rotated.publicKey), publicKey: rotated.publicKey }];
  assert.equal(verifySignedReceiptEnvelope(envelope, { trustRoots: rotatedRoots }).authentic, true);
  // No trust roots, no verification.
  assert.throws(() => verifySignedReceiptEnvelope(envelope, { trustRoots: [] }), /RECEIPT_TRUST_ROOTS_REQUIRED/);
});
