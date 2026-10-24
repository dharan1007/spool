/**
 * Temporal Activities for SPOOL Enterprise Migration Platform.
 */

export async function executeSpoolMigrationActivity({ endpoint, apiKey, migrationPayload }) {
  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey
  };
  const base = endpoint.replace(/\/$/, '');

  // 1. Create Migration
  const createRes = await fetch(`${base}/v2/migrations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(migrationPayload)
  });
  if (!createRes.ok) throw new Error(`Failed to create migration: ${createRes.status}`);
  const { result: { migrationId } } = await createRes.json();

  // 2. Plan
  await fetch(`${base}/v2/migrations/${migrationId}/plan`, { method: 'POST', headers });

  // 3. Dry-Run
  await fetch(`${base}/v2/migrations/${migrationId}/dry-run`, { method: 'POST', headers });

  // 4. Approve
  await fetch(`${base}/v2/migrations/${migrationId}/approve`, { method: 'POST', headers });

  // 5. Execute
  const execRes = await fetch(`${base}/v2/migrations/${migrationId}/execute`, { method: 'POST', headers });
  const execData = await execRes.json();
  if (execData?.result?.status !== 'COMPLETE') {
    throw new Error(`SPOOL Migration ${migrationId} failed with status: ${execData?.result?.status}`);
  }

  // 6. Receipt
  const receiptRes = await fetch(`${base}/v2/migrations/${migrationId}/receipt`, { method: 'GET', headers });
  const { result: receipt } = await receiptRes.json();

  return receipt;
}
