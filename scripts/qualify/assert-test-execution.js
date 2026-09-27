#!/usr/bin/env node
import { readFileSync } from 'node:fs';

// An exit-code-zero TAP stream can contain ZERO executed tests, or only SKIPs.
// Neither is a PostgreSQL qualification. The CI gate treats absent, malformed,
// contradictory, omitted, or incomplete summaries as NOT_EXECUTED.
export function assertExecutedTap(tap, { minimumTests = 1 } = {}) {
  if (typeof tap !== 'string' || !Number.isSafeInteger(minimumTests) || minimumTests < 1) {
    throw new TypeError('A TAP transcript and positive minimum test count are required');
  }
  const lines = tap.replace(/\r\n/g, '\n').split('\n');
  if (!lines.some(line => /^TAP version 13\s*$/.test(line))) {
    throw new Error('Node TAP v13 transcript header missing');
  }
  const fields = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const summary = {};
  for (const name of fields) {
    const entries = lines.filter(line => new RegExp('^# ' + name + ' [0-9]+\\s*$').test(line));
    if (entries.length !== 1) throw new Error('TAP summary missing or ambiguous: ' + name);
    summary[name] = Number(entries[0].match(/\d+/)[0]);
    if (!Number.isSafeInteger(summary[name])) throw new Error('TAP counter not a safe integer: ' + name);
  }
  if (summary.tests < minimumTests) throw new Error('Insufficient executed tests: ' + summary.tests + ' < ' + minimumTests);
  if (summary.pass !== summary.tests || summary.fail !== 0 || summary.cancelled !== 0
    || summary.skipped !== 0 || summary.todo !== 0) {
    throw new Error('TAP contains failed, cancelled, skipped, TODO, or unaccounted test cases');
  }
  if (!lines.some(line => /^ok \d+ - /.test(line))) throw new Error('No completed TAP test entries');
  if (lines.some(line => /^not ok \d+ - /.test(line))) throw new Error('TAP reports failure despite clean summary');
  return Object.freeze({ status: 'EXECUTED_ALL_PASS', ...summary });
}

if (process.argv[1] && /(?:^|[/\\])assert-test-execution\.js$/.test(process.argv[1])) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/qualify/assert-test-execution.js FILE MINIMUM_TESTS');
    const minimumTests = Number(process.argv[3]);
    const result = assertExecutedTap(readFileSync(process.argv[2], 'utf8'), { minimumTests });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('POSTGRES_TEST_NOT_EXECUTED: ' + error.message);
    process.exitCode = 1;
  }
}
