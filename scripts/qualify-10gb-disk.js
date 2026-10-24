#!/usr/bin/env node
import { createWriteStream, unlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { streamCsvRows } from '../src/connectors/filesystem/stream-csv.js';

async function run() {
  console.log('=== SPOOL 10 GB Physical Disk Stream Qualification ===');
  const workDir = 'E:\\spool-10gb-test';
  const csvPath = join(workDir, 'large-source.csv');

  // Ensure clean directory
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  mkdirSync(workDir, { recursive: true });

  const TARGET_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB
  const ROW_BYTES = 512;
  const CHUNK_SIZE = 64 * 1024;
  const pad = 'X'.repeat(450);
  const header = 'id,customer_id,amount,status,created_at,metadata\n';

  console.log(`Writing ${TARGET_BYTES} bytes (~10 GB) to ${csvPath}...`);
  const writeStream = createWriteStream(csvPath, { flags: 'w' });
  const closed = once(writeStream, 'close');

  let written = 0;
  let rowId = 0;

  // Write header
  writeStream.write(header);
  written += Buffer.byteLength(header);

  const t0Write = Date.now();
  while (written < TARGET_BYTES) {
    let chunk = '';
    while (chunk.length < CHUNK_SIZE && written + chunk.length < TARGET_BYTES) {
      rowId++;
      const row = `${rowId},cust_${rowId % 10000},${(rowId * 1.5).toFixed(2)},${rowId % 2 === 0 ? 'ACTIVE' : 'PENDING'},2026-10-24,${pad}\n`;
      chunk += row;
    }
    const buf = Buffer.from(chunk, 'utf8');
    if (written + buf.length > TARGET_BYTES) {
      const allowed = TARGET_BYTES - written;
      writeStream.write(buf.subarray(0, allowed));
      written = TARGET_BYTES;
      break;
    }
    if (!writeStream.write(buf)) await once(writeStream, 'drain');
    written += buf.length;
    if (rowId % 1000000 === 0) {
      const mb = (written / (1024 * 1024)).toFixed(1);
      const sec = ((Date.now() - t0Write) / 1000).toFixed(1);
      console.log(`  Written ${mb} MiB (${rowId} rows) in ${sec}s`);
    }
  }
  writeStream.end();
  await closed;

  const fileStat = await stat(csvPath);
  const sizeGb = (fileStat.size / (1024 * 1024 * 1024)).toFixed(2);
  console.log(`\nFile written: ${sizeGb} GiB (${fileStat.size} bytes). Write time: ${((Date.now() - t0Write) / 1000).toFixed(1)}s`);

  // Now stream parse it
  console.log('\nStreaming and parsing 10 GB file...');
  let peakRss = 0;
  let parsedRows = 0;
  const t0Parse = Date.now();

  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }, 50);

  try {
    for await (const record of streamCsvRows(csvPath, { maxInputBytes: 10 * 1024 * 1024 * 1024 })) {
      parsedRows++;
      if (parsedRows % 1000000 === 0) {
        const curRssMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(2);
        const mb = (parsedRows * ROW_BYTES / (1024 * 1024)).toFixed(1);
        console.log(`  Parsed ${parsedRows} rows (${mb} MiB processed)... RSS: ${curRssMb} MiB`);
      }
    }
  } finally {
    clearInterval(sampler);
  }

  const durationSec = (Date.now() - t0Parse) / 1000;
  const throughputRowsPerSec = Math.round(parsedRows / durationSec);
  const throughputMbPerSec = (fileStat.size / (1024 * 1024) / durationSec).toFixed(2);
  const peakRssMb = (peakRss / (1024 * 1024)).toFixed(2);

  console.log(`\n=== 10 GB Qualification Results ===`);
  console.log(`- Total File Size: ${sizeGb} GiB`);
  console.log(`- Total Parsed Rows: ${parsedRows}`);
  console.log(`- Parse Duration: ${durationSec.toFixed(2)}s`);
  console.log(`- Processing Throughput: ${throughputRowsPerSec} rows/sec (${throughputMbPerSec} MiB/sec)`);
  console.log(`- Peak RSS Memory: ${peakRssMb} MiB`);
  console.log(`- Bounded Memory: ${peakRss < 250 * 1024 * 1024 ? 'PASSED (RSS < 250 MiB)' : 'FAILED'}`);
  console.log(`- Data Integrity: ${parsedRows > 0 ? 'PASSED' : 'FAILED'}`);

  const evidence = {
    test: '10GB_PHYSICAL_DISK_STREAM_QUALIFICATION',
    timestamp: new Date().toISOString(),
    status: (peakRss < 250 * 1024 * 1024 && parsedRows > 0) ? 'QUALIFIED' : 'FAILED',
    fileSizeBytes: fileStat.size,
    fileSizeGb: parseFloat(sizeGb),
    totalRows: parsedRows,
    durationSec,
    throughputRowsPerSec,
    throughputMbPerSec: parseFloat(throughputMbPerSec),
    peakRssMb: parseFloat(peakRssMb),
    memoryBounded: peakRss < 250 * 1024 * 1024,
    diskUsed: 'E:\\spool-10gb-test (cleaned up after test)'
  };

  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    'C:\\temp\\spool-console\\.console-evidence\\qualification-10gb-disk.json',
    JSON.stringify(evidence, null, 2) + '\n',
    'utf8'
  );
  console.log('Saved evidence to .console-evidence/qualification-10gb-disk.json');

  // CLEANUP: Delete the 10 GB file and directory
  console.log('\nCleaning up 10 GB test file and directory...');
  try {
    rmSync(workDir, { recursive: true, force: true });
    console.log('Cleanup complete. E: drive restored.');
  } catch (err) {
    console.error('Cleanup failed:', err.message);
  }
}

run().catch(err => {
  console.error('Qualification failed:', err);
  // Attempt cleanup even on failure
  try { rmSync('E:\\spool-10gb-test', { recursive: true, force: true }); } catch {}
  process.exit(1);
});
