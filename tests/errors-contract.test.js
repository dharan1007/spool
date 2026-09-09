import test from 'node:test';
import assert from 'node:assert/strict';
import { SpoolError, toErrorEnvelope } from '../src/core/errors.js';

test('customer-safe error envelope has stable code, recoverability and next actions', () => {
  const envelope = toErrorEnvelope(new SpoolError('SOURCE_TOO_LARGE', 'Source exceeds configured limit', { bytes: 10, limit: 5 }));
  assert.deepEqual(envelope, {
    code: 'SOURCE_TOO_LARGE',
    message: 'Source exceeds configured limit',
    details: { bytes: 10, limit: 5 },
    severity: 'user_action',
    retryable: true,
    nextActions: ['Choose a smaller source', 'Use the local runner for larger bounded migrations']
  });
});

test('unknown internal errors do not expose stack or arbitrary object fields', () => {
  const error = new Error('database exploded');
  error.secret = 'should-not-leak';
  const envelope = toErrorEnvelope(error);
  assert.equal(envelope.code, 'INTERNAL_ERROR');
  assert.equal(envelope.severity, 'internal');
  assert.equal(envelope.retryable, false);
  assert.doesNotMatch(JSON.stringify(envelope), /secret|stack/);
});
