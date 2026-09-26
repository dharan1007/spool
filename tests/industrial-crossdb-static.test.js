import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('MySQL exact-commit capability must reject nontransactional target engines', async () => {
  const preflight = await source('src/connectors/mysql/preflight.js');
  assert.match(
    preflight,
    /ENGINE|information_schema\.TABLES[\s\S]*ENGINE|transactional/i,
    'MySQL preflight does not bind/reject the target storage engine, so MyISAM can enter a path advertised as transactional/exact'
  );
  assert.match(
    preflight,
    /InnoDB/i,
    'MySQL exact-commit mode must positively require a transaction-safe engine such as InnoDB'
  );
});

test('MySQL target contract must bind or reject user triggers', async () => {
  const preflight = await source('src/connectors/mysql/preflight.js');
  assert.match(
    preflight,
    /information_schema\.TRIGGERS|SHOW\s+TRIGGERS|TARGET_TRIGGER_UNSUPPORTED/i,
    'MySQL target contract ignores triggers even though BEFORE triggers can modify inserted values'
  );
});

test('MySQL target contract must include value-shape semantics, not only broad DATA_TYPE', async () => {
  const preflight = await source('src/connectors/mysql/preflight.js');
  for (const token of ['CHARACTER_MAXIMUM_LENGTH', 'NUMERIC_PRECISION', 'NUMERIC_SCALE']) {
    assert.match(preflight, new RegExp(token, 'i'),
      `MySQL target contract does not bind ${token}; narrowing columns can leave the contract identity unchanged`);
  }
});

test('SQL Server target contract must bind or reject DML triggers', async () => {
  const preflight = await source('src/connectors/mssql/preflight.js');
  assert.match(
    preflight,
    /sys\.triggers|INSTEAD\s+OF|TARGET_TRIGGER_UNSUPPORTED/i,
    'SQL Server target contract ignores DML triggers, including INSTEAD OF triggers that can replace the requested write'
  );
});

test('SQL Server target contract must include value-shape semantics, not only broad DATA_TYPE', async () => {
  const preflight = await source('src/connectors/mssql/preflight.js');
  for (const token of ['CHARACTER_MAXIMUM_LENGTH', 'NUMERIC_PRECISION', 'NUMERIC_SCALE']) {
    assert.match(preflight, new RegExp(token, 'i'),
      `SQL Server target contract does not bind ${token}; narrowing columns can leave the contract identity unchanged`);
  }
});

test('connector descriptors must not claim exactCommitEvidence when target-side effects are unproven', async () => {
  const [mysqlRuntime, mssqlRuntime] = await Promise.all([
    source('src/connectors/mysql/runtime.js'),
    source('src/connectors/mssql/runtime.js')
  ]);
  for (const [name, code] of [['mysql', mysqlRuntime], ['mssql', mssqlRuntime]]) {
    const claimsExact = /exactCommitEvidence\s*:\s*true/.test(code);
    if (!claimsExact) continue;
    const preflight = await source(`src/connectors/${name}/preflight.js`);
    assert.match(preflight, /trigger/i,
      `${name} advertises exactCommitEvidence but its target contract has no trigger semantics`);
  }
});
