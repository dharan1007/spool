import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { metrics, defaultRegistry } from '../src/observability/prometheus.js';

test('Kubernetes deployment and ServiceMonitor specifications', async () => {
  const deploymentYaml = await readFile('helm/spool/templates/deployment.yaml', 'utf8');
  const valuesYaml = await readFile('helm/spool/values.yaml', 'utf8');
  // Probes must be wired to the chart values that carry the real daemon routes.
  assert.ok(deploymentYaml.includes('path: {{ .Values.probes.liveness.path }}'));
  assert.ok(deploymentYaml.includes('path: {{ .Values.probes.readiness.path }}'));
  assert.ok(/liveness:\n\s+path: \/v2\/health\n/.test(valuesYaml));
  assert.ok(/readiness:\n\s+path: \/v2\/ready\n/.test(valuesYaml));
  assert.ok(deploymentYaml.includes('containerPort: 8080'));

  const serviceMonitorYaml = await readFile('helm/spool/templates/servicemonitor.yaml', 'utf8');
  assert.ok(serviceMonitorYaml.includes('path: /v2/metrics'));
  assert.ok(serviceMonitorYaml.includes('kind: ServiceMonitor'));
});

test('Prometheus Scraper Emulation', async () => {
  // Populate metrics
  metrics.migrationsTotal.inc({ status: 'COMPLETE', target: 'postgres' }, 12);
  metrics.migrationsTotal.inc({ status: 'FAILED', target: 'sqlite' }, 1);
  metrics.rowsWrittenTotal.inc({ migration_id: 'mig_k8s_prod', target: 'postgres' }, 500000);
  metrics.batchDurationSeconds.observe({ target: 'postgres' }, 0.245);

  const scrapedText = defaultRegistry.metricsOutput();
  assert.ok(scrapedText.includes('# TYPE spool_migrations_total counter'));
  assert.ok(scrapedText.includes('spool_migrations_total{status="COMPLETE",target="postgres"} 12'));
  assert.ok(scrapedText.includes('spool_rows_written_total{migration_id="mig_k8s_prod",target="postgres"} 500000'));
  assert.ok(scrapedText.includes('spool_batch_duration_seconds_bucket'));
  assert.ok(scrapedText.includes('spool_batch_duration_seconds_count'));
});
