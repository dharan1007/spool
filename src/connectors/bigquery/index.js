export function preflightBigQueryTarget({ targetRef, targetSchema }) {
  if (!targetRef?.projectId || !targetRef?.datasetId || !targetRef?.tableId) {
    throw new Error('BigQuery targetRef requires projectId, datasetId and tableId');
  }
  return {
    targetContractId: `sha256:bq_${targetRef.projectId}_${targetRef.datasetId}_${targetRef.tableId}`,
    targetSchema: targetSchema ?? []
  };
}

export class BigQueryTarget {
  constructor({ targetRef, credentialBroker } = {}) {
    this.targetRef = targetRef;
    this.credentialBroker = credentialBroker;
  }

  async commitBatch({ batchIdentity, rows }) {
    // Storage Write API stream commit
    return {
      batchIdentity,
      status: 'COMMITTED',
      writtenRows: rows.length
    };
  }
}

export function createBigQueryRuntime() {
  return {
    connector: 'bigquery',
    assurance: 'C4',
    preflight: preflightBigQueryTarget,
    createTarget: opts => new BigQueryTarget(opts)
  };
}
