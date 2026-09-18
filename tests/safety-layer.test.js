import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanStructure, addSafetyLayers, checkAgentSafety } from '../src/safety/safety-layer.js';

test('validatePlanStructure refuses non-object plans', () => {
  assert.throws(() => validatePlanStructure(null), /INVALID_PLAN_STRUCTURE/);
  assert.throws(() => validatePlanStructure([]), /INVALID_PLAN_STRUCTURE/);
  assert.throws(() => validatePlanStructure('plan'), /INVALID_PLAN_STRUCTURE/);
  assert.doesNotThrow(() => validatePlanStructure({ add: [] }));
});

test('validatePlanStructure refuses plans beyond the maximum depth', () => {
  assert.throws(() => validatePlanStructure({ __depth: 20 }), /PLAN_DEPTH_EXCEEDED/);
  assert.doesNotThrow(() => validatePlanStructure({ __depth: 19 }));
});

test('validatePlanStructure enforces the request rate limit', () => {
  assert.throws(() => validatePlanStructure({ __rateLapsed: Date.now() }), /RATE_LIMIT_EXCEEDED/);
  assert.doesNotThrow(() => validatePlanStructure({ __rateLapsed: Date.now() - 2000 }));
});

test('validatePlanStructure refuses forbidden plans and reports reasons', () => {
  try {
    validatePlanStructure({ __forbidden: ['destructive', 'schema-change'] });
    assert.fail('expected PLAN_FORBIDDEN');
  } catch (error) {
    assert.match(error.message, /PLAN_FORBIDDEN/);
    assert.deepEqual(error.details.reasons, [
      'destructive operations require approval',
      'schema changes require migration protocol'
    ]);
  }
  assert.doesNotThrow(() => validatePlanStructure({ __forbidden: [] }));
});

test('addSafetyLayers increments depth and stamps the rate window', () => {
  const layered = addSafetyLayers({ add: [{ column: 'x' }] });
  assert.equal(layered.__depth, 1);
  assert.equal(typeof layered.__rateLapsed, 'number');
  const nested = addSafetyLayers(layered);
  assert.equal(nested.__depth, 2);
});

test('addSafetyLayers flags undeclared plan fields and destructive types', () => {
  const expired = plan => { plan.__rateLapsed = Date.now() - 2000; return plan; };

  const whitelisted = addSafetyLayers({ add: [] });
  assert.deepEqual(whitelisted.__forbidden, []);
  assert.doesNotThrow(() => validatePlanStructure(expired(whitelisted)));

  const undeclared = addSafetyLayers({ add: [], dropEverything: true });
  assert.ok(undeclared.__forbidden.includes('undeclared-fields'));
  assert.throws(() => validatePlanStructure(expired(undeclared)), /PLAN_FORBIDDEN/);

  const destructive = addSafetyLayers({ __type: 'truncate' });
  assert.ok(destructive.__forbidden.includes('destructive'));
  assert.throws(() => validatePlanStructure(expired(destructive)), /PLAN_FORBIDDEN/);

  const schemaChange = addSafetyLayers({ __type: 'schema-migration', __destructiveStep: true });
  assert.ok(schemaChange.__forbidden.includes('schema-change'));
  assert.throws(() => validatePlanStructure(expired(schemaChange)), /PLAN_FORBIDDEN/);

  const approved = addSafetyLayers({ __type: 'truncate', __requiresApproval: false });
  assert.deepEqual(approved.__forbidden, []);
});

test('checkAgentSafety flags unbounded iteration, dangerous SQL and privilege gaps', () => {
  const clean = checkAgentSafety({ command: 'SELECT 1' }, {});
  assert.equal(clean.safe, true);
  assert.deepEqual(clean.issues, []);

  const loop = checkAgentSafety({ command: 'SELECT 1', __iterations: 101 }, {});
  assert.equal(loop.safe, false);
  assert.ok(loop.issues.some(issue => /unbounded iteration/.test(issue)));

  const dangerous = checkAgentSafety({ command: 'DROP TABLE users' }, {});
  assert.equal(dangerous.safe, false);
  assert.ok(dangerous.issues.some(issue => /dangerous SQL pattern: DROP/.test(issue)));
  assert.doesNotMatch(dangerous.sanitizedRequest.command, /DROP TABLE/);
  assert.match(dangerous.sanitizedRequest.command, /\/\* filtered: DROP\s+\*\//);

  const privileged = checkAgentSafety({ command: 'SELECT 1', __needsSuperuser: true }, { isSuperuser: false });
  assert.equal(privileged.safe, false);
  assert.ok(privileged.issues.some(issue => /superuser/.test(issue)));
  assert.equal(privileged.sanitizedRequest.__needsSuperuser, undefined);
});
