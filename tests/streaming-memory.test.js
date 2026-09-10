import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const MAX_OLD_SPACE_MIB = 48;

function runConstrainedHeap() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${MAX_OLD_SPACE_MIB}`,
      'tests/fixtures/streaming-memory-child.js'
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('Local Runner completes a >50 MiB CSV with V8 max-old-space constrained to 48 MiB', { timeout: 180_000 }, async () => {
  const result = await runConstrainedHeap();
  assert.equal(result.signal, null, `child terminated by ${result.signal}\n${result.stderr}`);
  assert.equal(result.code, 0, `constrained-heap child failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const match = result.stdout.match(/BOUNDED_MEMORY_OK (\{.*\})/);
  assert.ok(match, `proof marker missing\n${result.stdout}`);
  const proof = JSON.parse(match[1]);
  assert.ok(proof.sourceBytes > 50 * 1024 * 1024);
  assert.equal(proof.sourceRows, 230_000);
  assert.equal(proof.writtenRows, 229_991);
  assert.equal(proof.rejectedRows, 9);
  // V8's total heap limit includes spaces other than old-space, so it is expected to
  // be larger than --max-old-space-size. The launch argument above is the actual
  // old-space constraint; this upper bound catches an accidentally unconstrained run.
  assert.ok(proof.heapLimitMiB <= 128, `unexpected total V8 heap limit ${proof.heapLimitMiB} MiB`);
});
