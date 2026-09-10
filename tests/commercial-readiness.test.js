import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const REQUIRED_DOCS = [
  'docs/CUSTOMER_ENGAGEMENT.md',
  'docs/AUTHORIZATION_TEMPLATE.md',
  'docs/DELIVERY_ACCEPTANCE_TEMPLATE.md',
  'docs/CASE_STUDY_CONSENT_TEMPLATE.md'
];

test('commercial operating documents exist with zero-cost safety boundaries', async () => {
  const docs = Object.fromEntries(await Promise.all(REQUIRED_DOCS.map(async path => [path, await readFile(path, 'utf8')])));
  const engagement = docs['docs/CUSTOMER_ENGAGEMENT.md'];
  assert.match(engagement, /metadata-only/i);
  assert.match(engagement, /private/i);
  assert.match(engagement, /payment/i);
  assert.match(engagement, /written authorization/i);
  assert.match(engagement, /backup/i);
  assert.match(engagement, /receipt/i);
  assert.match(engagement, /acceptance/i);

  const authorization = docs['docs/AUTHORIZATION_TEMPLATE.md'];
  assert.match(authorization, /target mutation/i);
  assert.match(authorization, /backup/i);
  assert.match(authorization, /authorized/i);
  assert.match(authorization, /scope/i);

  const delivery = docs['docs/DELIVERY_ACCEPTANCE_TEMPLATE.md'];
  assert.match(delivery, /delivery manifest/i);
  assert.match(delivery, /verification/i);
  assert.match(delivery, /receipt/i);
  assert.match(delivery, /accept/i);

  const consent = docs['docs/CASE_STUDY_CONSENT_TEMPLATE.md'];
  assert.match(consent, /optional/i);
  assert.match(consent, /anonym/i);
  assert.match(consent, /consent/i);
  assert.match(consent, /revok/i);

  for (const [path, text] of Object.entries(docs)) {
    assert.doesNotMatch(text, /Aadhaar|bank account number|home address/i, `${path} must not publish sensitive operator details`);
  }
});
