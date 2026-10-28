import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_DIR = join(ROOT, 'engineering', 'completion');

const REGISTERS = Object.freeze([
  'MASTER_REQUIREMENTS.json',
  'CURRENT_STATE.json',
  'REMAINING_TASKS.json',
  'TEST_RESULTS.json',
  'BLOCKERS.json'
]);

const TASK_STATUSES = Object.freeze(['COMPLETED', 'PARTIAL', 'EXTERNALLY_BLOCKED', 'NOT_STARTED']);
const VERIFICATION_STATUSES = Object.freeze(['TESTED', 'EXTERNALLY_BLOCKED', 'FAILED', 'PARTIAL']);
const BLOCKER_TYPES = Object.freeze(['EXTERNALLY_BLOCKED', 'ENVIRONMENT_CAPACITY']);
const BLOCKER_ID = /^B\d{3}$/;
const RESOLVED_ID = /^R\d{3}$/;
const COMMIT_SHA = /\b[0-9a-f]{40}\b/g;

function raw(name) {
  return readFileSync(join(REGISTER_DIR, name), 'utf8');
}

function load(name) {
  return JSON.parse(raw(name));
}

function registerText() {
  return REGISTERS.map(name => raw(name)).join('\n');
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function commitExists(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAncestor(sha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function blockerIds(text) {
  return [...String(text).matchAll(/\bB\d{3}\b/g)].map(match => match[0]);
}

function activeBlockerIds(blockers) {
  return new Set(blockers.blockers.map(item => item.id));
}

test('every completion register is valid JSON with the required envelope fields', () => {
  for (const name of REGISTERS) {
    let data;
    assert.doesNotThrow(() => { data = load(name); }, `${name} must parse as JSON`);
    assert.equal(typeof data.register, 'string', `${name} must declare a register name`);
    assert.match(data.updatedAt, /^\d{4}-\d{2}-\d{2}$/, `${name} must carry an ISO date updatedAt`);
    assert.equal(typeof data.branch, 'string', `${name} must declare the branch it describes`);
    assert.ok(!Number.isNaN(Date.parse(data.updatedAt)), `${name} updatedAt must be a real date`);
  }
  const branches = new Set(REGISTERS.map(name => load(name).branch));
  assert.equal(branches.size, 1, `registers disagree about the branch: ${[...branches].join(', ')}`);
});

test('master requirements use only the declared status vocabulary', () => {
  const data = load('MASTER_REQUIREMENTS.json');
  assert.ok(Array.isArray(data.statusVocabulary) && data.statusVocabulary.length > 0);
  const vocabulary = new Set(data.statusVocabulary);
  assert.ok(Array.isArray(data.domains) && data.domains.length > 0, 'domains are required');
  const ids = data.domains.map(domain => domain.id);
  assert.equal(new Set(ids).size, ids.length, 'domain ids must be unique');
  for (const domain of data.domains) {
    assert.equal(typeof domain.id, 'string', 'every domain needs an id');
    assert.equal(typeof domain.requirement, 'string', `${domain.id} needs a requirement`);
    assert.ok(vocabulary.has(domain.status), `${domain.id} has status ${domain.status} outside the vocabulary`);
    assert.equal(typeof domain.verifiedResults, 'string', `${domain.id} needs recorded verifiedResults`);
    assert.ok(domain.verifiedResults.length > 0, `${domain.id} verifiedResults must not be empty`);
  }
});

test('current state binds evidence to a commit that exists and is an ancestor of HEAD', () => {
  const data = load('CURRENT_STATE.json');
  for (const field of ['workingDirectory', 'baseCommit', 'environmentConstraints', 'verificationState', 'externalBlocks', 'remainingWork']) {
    assert.ok(data[field] !== undefined, `CURRENT_STATE is missing ${field}`);
  }
  assert.equal(typeof data.testedCommitSha, 'string', 'CURRENT_STATE must bind verification to testedCommitSha');
  assert.match(data.testedCommitSha, /^[0-9a-f]{40}$/, 'testedCommitSha must be an exact 40-character SHA');
  assert.ok(commitExists(data.testedCommitSha), `testedCommitSha ${data.testedCommitSha} is not a commit in this repository`);
  assert.ok(isAncestor(data.testedCommitSha), `testedCommitSha ${data.testedCommitSha} is not an ancestor of HEAD (stale or fabricated binding)`);
  assert.ok(commitExists(data.baseCommit), `baseCommit ${data.baseCommit} is not a commit in this repository`);
  assert.equal(typeof data.verificationState, 'object', 'verificationState must be an object');
  assert.ok(Object.keys(data.verificationState).length > 0, 'verificationState must record at least one result');
});

test('remaining tasks use valid statuses and carry evidence', () => {
  const data = load('REMAINING_TASKS.json');
  assert.ok(Array.isArray(data.orderedTasks) && data.orderedTasks.length > 0);
  assert.equal(typeof data.acceptanceGate, 'string');
  const ids = data.orderedTasks.map(task => task.id);
  assert.equal(new Set(ids).size, ids.length, 'task ids must be unique');
  for (const task of data.orderedTasks) {
    assert.match(task.id, /^T\d{3}$/, `${task.id} is not a valid task id`);
    assert.equal(typeof task.task, 'string', `${task.id} needs a task description`);
    assert.ok(TASK_STATUSES.includes(task.status), `${task.id} has invalid status ${task.status}`);
    assert.equal(typeof task.evidence, 'string', `${task.id} needs evidence`);
    assert.ok(task.evidence.length > 0, `${task.id} evidence must not be empty`);
  }
});

test('test results use valid statuses and reconcile their own counts', () => {
  const data = load('TEST_RESULTS.json');
  assert.ok(Array.isArray(data.runs) && data.runs.length > 0);
  for (const run of data.runs) {
    assert.equal(typeof run.suite, 'string', 'every run needs a suite name');
    assert.equal(typeof run.command, 'string', `${run.suite} needs a command`);
    assert.ok(VERIFICATION_STATUSES.includes(run.verification), `${run.suite} has invalid verification ${run.verification}`);
    if (run.commitSha) assert.match(run.commitSha, /^[0-9a-f]{40}$/, `${run.suite} commitSha is not exact`);
    if (run.tests !== undefined) {
      const counters = ['pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => run[key] ?? 0);
      assert.ok(counters.every(value => Number.isInteger(value) && value >= 0), `${run.suite} counters must be non-negative integers`);
      const sum = counters.reduce((total, value) => total + value, 0);
      assert.equal(sum, run.tests, `${run.suite} counters ${JSON.stringify(counters)} do not sum to tests=${run.tests}`);
    }
  }
  const counts = data.countReconciliation;
  assert.ok(counts, 'countReconciliation is required');
  const sum = ['pass', 'fail', 'cancelled', 'skipped', 'todo'].reduce((total, key) => total + (counts[key] ?? 0), 0);
  assert.equal(sum, counts.tests, `countReconciliation does not sum: ${sum} !== ${counts.tests}`);
});

test('blockers and resolved items cannot overlap and citations must be active blockers', () => {
  const data = load('BLOCKERS.json');
  assert.ok(Array.isArray(data.blockers));
  assert.ok(Array.isArray(data.resolvedThisSession));
  const active = new Set();
  for (const blocker of data.blockers) {
    assert.match(blocker.id, BLOCKER_ID, `invalid blocker id ${blocker.id}`);
    assert.ok(!active.has(blocker.id), `duplicate blocker id ${blocker.id}`);
    active.add(blocker.id);
    assert.ok(BLOCKER_TYPES.includes(blocker.type), `${blocker.id} has invalid type ${blocker.type}`);
    for (const field of ['domain', 'missingResource', 'notPassedLabel']) {
      assert.equal(typeof blocker[field], 'string', `${blocker.id} needs ${field}`);
      assert.ok(blocker[field].length > 0, `${blocker.id} ${field} must not be empty`);
    }
  }
  const resolved = new Set();
  for (const item of data.resolvedThisSession) {
    assert.match(item.id, RESOLVED_ID, `invalid resolved id ${item.id}`);
    assert.ok(!resolved.has(item.id), `duplicate resolved id ${item.id}`);
    resolved.add(item.id);
    assert.equal(typeof item.resolution, 'string', `${item.id} needs a resolution`);
    assert.ok(item.resolution.length > 0, `${item.id} resolution must not be empty`);
  }
  const overlap = [...active].filter(id => resolved.has(id));
  assert.deepEqual(overlap, [], `ids cannot be both active and resolved: ${overlap.join(', ')}`);

  // Statuses cited as still blocking must correspond to an active blocker, not a
  // resolved one. Historical mentions are allowed only when the surrounding text
  // says so, which the registers encode as "resolved"/"was"/"HISTORICAL".
  const state = load('CURRENT_STATE.json');
  for (const field of ['externalBlocks', 'candidateVerdict']) {
    const value = state.verificationState[field] ?? state[field];
    const target = field === 'candidateVerdict' ? value : state.externalBlocks;
    for (const id of blockerIds(target)) {
      assert.ok(active.has(id), `CURRENT_STATE.${field} cites ${id}, which is not an active blocker`);
    }
  }
  const master = load('MASTER_REQUIREMENTS.json');
  const notes = master.domains
    .filter(domain => domain.status === 'EXTERNALLY_BLOCKED')
    .map(domain => domain.notes)
    .filter(Boolean)
    .join('\n');
  for (const id of blockerIds(notes)) {
    assert.ok(active.has(id), `MASTER_REQUIREMENTS blocked-domain notes cite ${id}, which is not an active blocker`);
  }
});

test('every commit SHA cited by a register resolves in this repository', () => {
  const cited = new Set(registerText().match(COMMIT_SHA) ?? []);
  assert.ok(cited.size > 0, 'registers must cite at least one commit');
  const missing = [...cited].filter(sha => !commitExists(sha));
  assert.deepEqual(missing, [], `registers cite commits that do not exist: ${missing.join(', ')}`);
});

test('registers agree on the base commit they extend', () => {
  const base = new Set();
  for (const name of ['MASTER_REQUIREMENTS.json', 'CURRENT_STATE.json', 'TEST_RESULTS.json']) {
    const data = load(name);
    if (data.baseCommit) base.add(data.baseCommit);
  }
  assert.equal(base.size, 1, `registers disagree about baseCommit: ${[...base].join(', ')}`);
});
