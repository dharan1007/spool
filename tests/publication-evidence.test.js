import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicationReport } from '../scripts/prepare-release-publication.js';
import { qualificationPlan } from '../scripts/qualify-bounded-release.js';

const commit = 'a'.repeat(40);
const version = '1.1.2';
const plan = qualificationPlan();
const entries = [...plan.commands, { id: 'security_audit' }, ...plan.requiredRealSurfaces, { id: 'signed_provenance' }].map(({ id }) => ({ id, status: 'PASS' }));
const report = { status: 'PASS', commitSha: commit, packageVersion: version, entries };

test('publication refuses incomplete, blocked, duplicate or stale qualification reports', () => {
  assert.doesNotThrow(() => validatePublicationReport(report, commit, version));
  for (const change of [
    { status: 'BLOCKED' }, { commitSha: 'b'.repeat(40) }, { packageVersion: '1.1.1' },
    { entries: entries.slice(0, -1) }, { entries: [...entries.slice(1), entries[1]] },
    { entries: entries.map(x => x.id === 'signed_provenance' ? { ...x, status: 'NOT_EXECUTED' } : x) },
    { entries: entries.map(x => x.id === 'browser_ui' ? { ...x, status: 'FAIL' } : x) }
  ]) assert.throws(() => validatePublicationReport({ ...report, ...change }, commit, version), /Complete exact-source qualification/);
});
