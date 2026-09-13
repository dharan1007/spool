import { fail } from '../core/errors.js';
import {
  createDurableFileSnapshot,
  loadDurableFileSnapshot,
  verifyFileAgainstSnapshot
} from '../connectors/source-snapshot.js';
import { inspectCsvStream, streamCsvRows } from '../connectors/filesystem/stream-csv.js';
import { loadMaterializedSnapshot, streamMaterializedRows } from '../connectors/materialized-snapshot.js';
import { createPostgresSourceRuntime } from '../connectors/postgres/source.js';
import { createMysqlSourceRuntime } from '../connectors/mysql/source.js';

const DEFAULT_SAMPLE_SIZE = 1000;

function requireObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message);
  return value;
}

async function collectMaterializedSample(materialized, sampleSize) {
  const sampleRows = [];
  for await (const { row } of streamMaterializedRows(materialized)) {
    sampleRows.push(row);
    if (sampleRows.length >= sampleSize) break;
  }
  return Object.freeze(sampleRows);
}

export function createDurableSourceCoordinator({
  sourcePolicy,
  credentialBroker,
  maxSourceBytes,
  sampleSize = DEFAULT_SAMPLE_SIZE,
  postgresRuntime = null,
  mysqlRuntime = null
} = {}) {
  if (!sourcePolicy || typeof sourcePolicy.resolve !== 'function') fail('INVALID_SERVICE_CONFIG', 'sourcePolicy.resolve() is required');
  if (!credentialBroker || typeof credentialBroker.withSecret !== 'function') fail('INVALID_SERVICE_CONFIG', 'credentialBroker.withSecret() is required');
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0) fail('INVALID_SERVICE_CONFIG', 'maxSourceBytes must be a positive safe integer');
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1) fail('INVALID_SERVICE_CONFIG', 'sampleSize must be a positive safe integer');
  const pg = postgresRuntime ?? createPostgresSourceRuntime({ credentialBroker });
  const my = mysqlRuntime ?? createMysqlSourceRuntime({ credentialBroker });

  async function prepareFilesystem(sourceRef, { snapshotDir, expectedSourceSnapshotId }) {
    if (sourceRef.secretRef) fail('UNSUPPORTED_LOCAL_CONNECTOR_SECRET', 'Filesystem source does not accept credentials');
    let sourcePath;
    try {
      sourcePath = await sourcePolicy.resolve(sourceRef.path ?? sourceRef.resource);
    } catch (error) {
      if (expectedSourceSnapshotId && error?.code === 'PATH_NOT_FOUND') {
        fail('SOURCE_CHANGED', 'Source file is no longer available at the approved path');
      }
      throw error;
    }
    const normalizedSourceRef = Object.freeze({ ...structuredClone(sourceRef), path: sourcePath });
    const durable = expectedSourceSnapshotId
      ? await loadDurableFileSnapshot(sourcePath, { snapshotDir, snapshotId: expectedSourceSnapshotId, maxBytes: maxSourceBytes })
      : await createDurableFileSnapshot(sourcePath, { snapshotDir, maxBytes: maxSourceBytes });
    const inspected = await inspectCsvStream(durable.snapshotPath, { sampleSize, maxInputBytes: maxSourceBytes });
    if (inspected.rowCount === 0) fail('EMPTY_SOURCE', 'CSV source must contain at least one data row');
    return Object.freeze({
      connector: 'filesystem',
      sourceRef: normalizedSourceRef,
      snapshot: durable.snapshot,
      sourceRows: inspected.rowCount,
      sourceBytes: durable.snapshot.size,
      sourceHeaders: inspected.headers,
      sampleRows: inspected.sampleRows,
      sourcePath,
      verify: () => verifyFileAgainstSnapshot(durable.snapshot),
      streamRows: () => streamCsvRows(durable.snapshotPath, { maxInputBytes: maxSourceBytes })
    });
  }

  async function preparePostgres(sourceRef, { snapshotDir, expectedSourceSnapshotId }) {
    let materialized;
    if (expectedSourceSnapshotId) {
      materialized = await loadMaterializedSnapshot({ snapshotDir, snapshotId: expectedSourceSnapshotId });
      if (materialized.snapshot.sourceIdentity?.connector !== 'postgres') {
        fail('SOURCE_SNAPSHOT_CORRUPT', 'Approved materialized snapshot is not a PostgreSQL source');
      }
    } else {
      materialized = await pg.materializeSnapshot(sourceRef, { snapshotDir });
    }
    const manifest = materialized.snapshot;
    if (manifest.rowCount === 0) fail('EMPTY_SOURCE', 'PostgreSQL source must contain at least one row');
    const headers = manifest.contract?.columns?.map(column => column.name);
    if (!Array.isArray(headers) || !headers.length || headers.some(name => typeof name !== 'string' || !name)) {
      fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized PostgreSQL snapshot has an invalid source contract');
    }
    const sampleRows = await collectMaterializedSample(materialized, sampleSize);
    return Object.freeze({
      connector: 'postgres',
      sourceRef: Object.freeze(structuredClone(sourceRef)),
      snapshot: manifest,
      sourceRows: manifest.rowCount,
      sourceBytes: manifest.byteCount,
      sourceHeaders: Object.freeze([...headers]),
      sampleRows,
      sourcePath: null,
      verify: async () => {
        const verified = await loadMaterializedSnapshot({ snapshotDir, snapshotId: manifest.snapshotId });
        if (verified.snapshot.snapshotId !== manifest.snapshotId) fail('SOURCE_DRIFT', 'Materialized PostgreSQL snapshot identity changed');
        return true;
      },
      streamRows: () => streamMaterializedRows(materialized)
    });
  }

  async function prepareMysql(sourceRef, { snapshotDir, expectedSourceSnapshotId }) {
    let materialized;
    if (expectedSourceSnapshotId) {
      materialized = await loadMaterializedSnapshot({ snapshotDir, snapshotId: expectedSourceSnapshotId });
      if (materialized.snapshot.sourceIdentity?.connector !== 'mysql') {
        fail('SOURCE_SNAPSHOT_CORRUPT', 'Approved materialized snapshot is not a MySQL source');
      }
    } else {
      materialized = await my.materializeSnapshot(sourceRef, { snapshotDir });
    }
    const manifest = materialized.snapshot;
    if (manifest.rowCount === 0) fail('EMPTY_SOURCE', 'MySQL source must contain at least one row');
    const headers = manifest.contract?.columns?.map(column => column.name);
    if (!Array.isArray(headers) || !headers.length || headers.some(name => typeof name !== 'string' || !name)) {
      fail('SOURCE_SNAPSHOT_CORRUPT', 'Materialized MySQL snapshot has an invalid source contract');
    }
    const sampleRows = await collectMaterializedSample(materialized, sampleSize);
    return Object.freeze({
      connector: 'mysql',
      sourceRef: Object.freeze(structuredClone(sourceRef)),
      snapshot: manifest,
      sourceRows: manifest.rowCount,
      sourceBytes: manifest.byteCount,
      sourceHeaders: Object.freeze([...headers]),
      sampleRows,
      sourcePath: null,
      verify: async () => {
        const verified = await loadMaterializedSnapshot({ snapshotDir, snapshotId: manifest.snapshotId });
        if (verified.snapshot.snapshotId !== manifest.snapshotId) fail('SOURCE_DRIFT', 'Materialized MySQL snapshot identity changed');
        return true;
      },
      streamRows: () => streamMaterializedRows(materialized)
    });
  }

  return Object.freeze({
    async prepare(sourceRefInput, { snapshotDir, expectedSourceSnapshotId = null } = {}) {
      const sourceRef = requireObject(sourceRefInput, 'INVALID_SOURCE_REF', 'sourceRef is required');
      if (typeof snapshotDir !== 'string' || !snapshotDir.trim()) fail('INVALID_SNAPSHOT_DIR', 'snapshotDir is required');
      if (sourceRef.connector === 'filesystem') return prepareFilesystem(sourceRef, { snapshotDir, expectedSourceSnapshotId });
      if (sourceRef.connector === 'postgres') return preparePostgres(sourceRef, { snapshotDir, expectedSourceSnapshotId });
      if (sourceRef.connector === 'mysql') return prepareMysql(sourceRef, { snapshotDir, expectedSourceSnapshotId });
      fail('UNSUPPORTED_SOURCE_CONNECTOR', `Unsupported source connector ${String(sourceRef.connector)}`);
    }
  });
}
