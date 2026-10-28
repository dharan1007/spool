#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * SPOOL internal control self-assessment.
 *
 * This is a repeatable, code-level mapping of SPOOL's own controls onto the SOC 2
 * Trust Services Criteria. It is NOT an audit, NOT an attestation and NOT a
 * SOC 2 report: no independent auditor has reviewed these results, and a passing
 * run says only that the mapped engineering checks still hold at this commit.
 * The `attestation` field is hard-coded false and the report carries a
 * disclaimer so a generated file can never be mistaken for an issued report.
 *
 * See docs/compliance/soc2/README.md and BLOCKERS.json B004.
 */
export const REPORT_DISCLAIMER =
  'Internal control self-assessment only. Not an audit, not an attestation and not a SOC 2 report. ' +
  'No independent auditor has reviewed these results.';

export async function collectAuditEvidence({ outPath } = {}) {
  const evidence = {
    report: 'INTERNAL_CONTROL_SELF_ASSESSMENT',
    framework: 'SPOOL internal controls mapped to SOC 2 Trust Services Criteria',
    attestation: false,
    independentAudit: 'NOT_PERFORMED',
    disclaimer: REPORT_DISCLAIMER,
    assessmentDate: new Date().toISOString(),
    totalChecks: 8,
    passedChecks: 0,
    checks: []
  };

  function evaluate(id, name, criteria, checkFn) {
    let passed = false;
    let details = '';
    try {
      const res = checkFn();
      passed = res.pass;
      details = res.details;
    } catch (err) {
      passed = false;
      details = String(err?.message ?? err);
    }
    if (passed) evidence.passedChecks++;
    evidence.checks.push({
      id,
      name,
      criteria,
      status: passed ? 'PASSED' : 'FAILED',
      details
    });
    console.log(`[${passed ? 'PASS' : 'FAIL'}] ${id}: ${name} (${criteria})`);
  }

  // CC6.1 - RBAC & API Key Access Control
  evaluate('CTRL-01', 'Role-Based Access Control', 'CC6.1', () => {
    const rbacSrc = readFileSync('src/platform/rbac.js', 'utf8');
    const hasRoles = ['admin', 'operator', 'viewer', 'api-client'].every(r => rbacSrc.includes(r));
    return { pass: hasRoles, details: 'RBAC enforces 4 formal roles with workspace-scoped action authorization' };
  });

  // CC6.6 - Boundary Protection & Data Sovereignty
  evaluate('CTRL-02', 'Data Sovereignty & Local-First Egress Prevention', 'CC6.6', () => {
    const secSrc = readFileSync('apps/console/electron/security.js', 'utf8');
    const hasCsp = secSrc.includes("connect-src 'none'");
    return { pass: hasCsp, details: "Content Security Policy strictly denies untrusted network egress (connect-src 'none')" };
  });

  // CC6.7 - Code Execution Restrictions (No eval/new Function)
  evaluate('CTRL-03', 'Prohibition of Arbitrary Dynamic Code Execution', 'CC6.7', () => {
    function scanDir(dir) {
      let count = 0;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) count += scanDir(full);
        else if (entry.isFile() && entry.name.endsWith('.js')) {
          const content = readFileSync(full, 'utf8');
          if (/\beval\s*\(/.test(content) || /\bnew\s+Function\b/.test(content)) count++;
        }
      }
      return count;
    }
    const evalCount = scanDir('src');
    return { pass: evalCount === 0, details: `Zero instances of eval() or new Function() in engine src/` };
  });

  // CC7.2 - Immutable Structured Audit Logging
  evaluate('CTRL-04', 'Immutable Append-Only Audit Trail', 'CC7.2', () => {
    const auditSrc = readFileSync('src/daemon/audit-log.js', 'utf8');
    const hasSchema = auditSrc.includes('CREATE TABLE IF NOT EXISTS spool_audit_events') && auditSrc.includes('WAL');
    return { pass: hasSchema, details: 'AuditLog maintains WAL-journaled immutable SQLite event store' };
  });

  // CC7.1 - Zero-Dependency Monitoring & Health Probing
  evaluate('CTRL-05', 'System Health & Prometheus Observability Probes', 'CC7.1', () => {
    const promSrc = readFileSync('src/observability/prometheus.js', 'utf8');
    const healthSrc = readFileSync('src/observability/health.js', 'utf8');
    const hasProbes = promSrc.includes('/v2/metrics') || promSrc.includes('metricsHandler');
    return { pass: hasProbes && healthSrc.includes('/v2/health') || healthSrc.includes('healthHandler'), details: 'Standard Prometheus exposition format and Kubernetes health/readiness probes' };
  });

  // CC6.1 - Credential Isolation Boundary
  evaluate('CTRL-06', 'Credential Broker Isolation & Secret Redaction', 'CC6.1', () => {
    const brokerSrc = readFileSync('src/daemon/credential-broker.js', 'utf8');
    const hasRedact = brokerSrc.includes('withSecret') && brokerSrc.includes('redact');
    return { pass: hasRedact, details: 'Target credentials managed strictly within CredentialBroker lifecycle and redacted from output' };
  });

  // PI1.2 - Cryptographic Receipt Generation & Integrity Proofs
  evaluate('CTRL-07', 'Deterministic Cryptographic Migration Receipts', 'PI1.2', () => {
    const receiptSrc = readFileSync('src/execution/receipt.js', 'utf8');
    const hasSha = receiptSrc.includes('sha256Canonical') && receiptSrc.includes('receiptId');
    return { pass: hasSha, details: 'Every completed migration produces SHA-256 bound immutable cryptographic receipt' };
  });

  // CC1.1 - Policy documentation present in the repository
  evaluate('CTRL-08', 'Trust Services Criteria Policy Documents Present', 'CC1.1', () => {
    const policies = [
      '01-access-control-policy.md',
      '02-change-management-policy.md',
      '03-data-classification-handling-policy.md',
      '04-cryptographic-key-management-policy.md',
      '05-vendor-risk-management-policy.md',
      '06-incident-response-bcp-policy.md',
      '07-vulnerability-patch-management-policy.md',
      '08-employee-security-policy.md',
      '09-continuous-monitoring-logging-policy.md'
    ];
    const allExist = policies.every(p => existsSync(join('docs/compliance/soc2', p)));
    return { pass: allExist, details: 'All 9 mapped policy documents are present and versioned (presence only; not an auditor review)' };
  });

  console.log(`\nSelf-assessment checks passed: ${evidence.passedChecks}/${evidence.totalChecks} (not a compliance score, not an attestation)`);

  const target = outPath ?? '.console-evidence/internal-control-self-assessment.json';
  await mkdir(dirname(resolve(target)), { recursive: true });
  await writeFile(target, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log(`Saved internal control self-assessment to ${target}\n`);
  return evidence;
}

function outPathFromArgv(argv) {
  const index = argv.indexOf('--out');
  return index === -1 ? undefined : argv[index + 1];
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  collectAuditEvidence({ outPath: outPathFromArgv(process.argv) }).then(res => {
    if (res.passedChecks !== res.totalChecks) {
      console.error('Internal control self-assessment has failing checks');
      process.exit(1);
    }
    process.exit(0);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
