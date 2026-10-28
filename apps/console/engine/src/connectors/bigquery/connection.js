import { fail } from '../../core/errors.js';
import { requestJson } from '../cloud-http.js';

export function normalizeBigQueryRef(ref = {}) {
  if (!ref || typeof ref !== 'object') fail('INVALID_BIGQUERY_CONFIG', 'targetRef must be an object');
  const projectId = String(ref.projectId || '').trim();
  const datasetId = String(ref.datasetId || '').trim();
  const tableId = String(ref.tableId || '').trim();
  const location = ref.location ? String(ref.location).trim() : 'US';
  const endpoint = ref.endpoint ? String(ref.endpoint).trim().replace(/\/$/, '') : (process.env.BIGQUERY_ENDPOINT || null);
  const token = ref.token ? String(ref.token).trim() : (process.env.BIGQUERY_TOKEN || null);

  if (!projectId) fail('INVALID_BIGQUERY_CONFIG', 'BigQuery projectId is required');
  if (!datasetId) fail('INVALID_BIGQUERY_CONFIG', 'BigQuery datasetId is required');
  if (!tableId) fail('INVALID_BIGQUERY_CONFIG', 'BigQuery tableId is required');
  // Identifiers cannot be query parameters. Reject delimiter, control and SQL syntax.
  if (!/^[A-Za-z0-9][A-Za-z0-9:.-]*$/.test(projectId) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(datasetId) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableId)) {
    fail('INVALID_BIGQUERY_IDENTIFIER', 'Unsafe or unsupported BigQuery project, dataset or table identifier');
  }
  if (endpoint) {
    let parsed;
    try { parsed = new URL(endpoint); } catch { fail('INVALID_BIGQUERY_ENDPOINT', 'Invalid BigQuery endpoint'); }
    if (!['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname)) {
      fail('INVALID_BIGQUERY_ENDPOINT', 'Custom BigQuery wire endpoints are restricted to local test interfaces');
    }
    if (!ref.token && !process.env.BIGQUERY_TOKEN) {
      fail('BIGQUERY_TOKEN_REQUIRED', 'Explicit test-endpoint bearer token is required');
    }
  }

  return Object.freeze({
    connector: 'bigquery',
    projectId,
    datasetId,
    tableId,
    location,
    endpoint,
    token
  });
}

export function escapeBigQueryTable(ref) {
  return `\`${ref.projectId}.${ref.datasetId}.${ref.tableId}\``;
}

export async function withBigQueryClient({ targetRef, credentialBroker, mockClient = null }, fn) {
  const ref = normalizeBigQueryRef(targetRef);

  if (mockClient) {
    return await fn(mockClient);
  }

  // Real HTTP network transport over wire endpoint
  if (ref.endpoint) {
    const client = {
      query: async (sqlText, params = []) => {
        const queryParameters = params.map(p => ({
          parameterType: { type: typeof p === 'boolean' ? 'BOOL' : (typeof p === 'number' ? (Number.isSafeInteger(p) ? 'INT64' : 'FLOAT64') : 'STRING') },
          parameterValue: { value: String(p) }
        }));

        const res = await requestJson(`${ref.endpoint}/bigquery/v2/projects/${ref.projectId}/queries`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ref.token}`
          },
          body: {
            query: sqlText,
            useLegacySql: false,
            parameterMode: 'POSITIONAL',
            queryParameters
          }
        });

        if (!res.ok) {
          const errText = await res.text();
          fail('BIGQUERY_QUERY_FAILED', `BigQuery query failed (${res.status}): ${errText}`);
        }

        const data = await res.json();
        if (data.jobComplete !== true) {
          fail('BIGQUERY_JOB_INCOMPLETE', 'Query job did not complete; do not interpret submission as a committed write');
        }
        if (data.errors?.length) {
          fail('BIGQUERY_QUERY_FAILED', 'BigQuery reported a query job error');
        }
        const fields = data.schema?.fields || [];
        const rows = (data.rows || []).map(r => {
          const obj = {};
          const fValues = r.f || [];
          for (let i = 0; i < fields.length; i++) {
            obj[fields[i].name] = fValues[i]?.v;
          }
          return obj;
        });

        return { rows, totalRows: data.totalRows };
      }
    };
    return await fn(client);
  }

  // Official @google-cloud/bigquery driver
  try {
    const { BigQuery } = await import('@google-cloud/bigquery');
    const bq = new BigQuery({
      projectId: ref.projectId
    });

    const client = {
      query: async (query, params = []) => {
        const [rows] = await bq.query({ query, params });
        return { rows };
      },
      getTable: async () => {
        return bq.dataset(ref.datasetId).table(ref.tableId);
      }
    };

    return await fn(client);
  } catch (err) {
    fail('BIGQUERY_CONNECTION_FAILED', `Failed to initialize BigQuery client: ${err?.message ?? err}`);
  }
}
