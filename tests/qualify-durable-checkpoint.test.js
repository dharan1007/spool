import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDurableJsonCheckpointStore } from '../scripts/qualify/postgres/durable-checkpoint.js';

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-durable-checkpoint-'));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('fsync/rename checkpoint is complete and owner-only across reopen', async () => withTemp(async dir => {
  const path = join(dir, 'checkpoint.json');
  const store = createDurableJsonCheckpointStore({ path });
  assert.equal(await store.load(), null);
  await store.save({ nextOffset: 10, id: 'first' });
  assert.deepEqual(await createDurableJsonCheckpointStore({path}).load(), {nextOffset:10,id:'first'});
  await store.save({ nextOffset: 20, id: 'second' });
  assert.deepEqual(await store.load(), { nextOffset:20,id:'second' });
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
}));

test('fault after temp file fsync never truncates the previous published checkpoint', async () => withTemp(async dir => {
  const path = join(dir, 'checkpoint.json');
  const store = createDurableJsonCheckpointStore({path});
  await store.save({nextOffset:10});
  const faulted = createDurableJsonCheckpointStore({path, onBeforeRename: async () => {
    throw new Error('injected crash boundary');
  }});
  await assert.rejects(faulted.save({nextOffset:20}), /injected crash boundary/);
  assert.deepEqual(await store.load(), {nextOffset:10});
  assert.deepEqual(await readdir(dir), ['checkpoint.json'], 'abandoned temp file must be deleted');
}));

test('corrupt checkpoint fails closed instead of silently replaying migration', async () => withTemp(async dir => {
  const path = join(dir, 'checkpoint.json');
  const store = createDurableJsonCheckpointStore({path});
  await writeFile(path, '{"nextOffset":', 'utf8');
  await assert.rejects(store.load(), SyntaxError);
  await writeFile(path, 'null', 'utf8');
  await assert.rejects(store.load(), /must be a JSON object/);
  await assert.rejects(store.save(null), TypeError);
}));

test('actual SIGKILL between temp fsync and rename leaves previous durable checkpoint', {
  skip: process.platform !== 'linux'
}, async () => withTemp(async dir => {
  const path = join(dir, 'checkpoint.json');
  const store = createDurableJsonCheckpointStore({path});
  await store.save({nextOffset:100});
  const moduleUrl = new URL('../scripts/qualify/postgres/durable-checkpoint.js', import.meta.url).href;
  const script = [
    'import {createDurableJsonCheckpointStore} from ' + JSON.stringify(moduleUrl) + ';',
    'const store = createDurableJsonCheckpointStore({path:process.argv[1],',
    'onBeforeRename:async()=>{process.stdout.write("READY\\n");await new Promise(()=>{})}});',
    'await store.save({nextOffset:200});'
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module','--eval',script,path], {
    stdio:['ignore','pipe','pipe']
  });
  let output = '';
  let stderr = '';
  child.stderr.on('data', c => { stderr += c.toString(); });
  const exit = new Promise(resolve => child.on('close',(code,signal)=>resolve({code,signal})));
  try {
    let timeout;
    try {
      await Promise.race([
      new Promise((resolve,reject)=>{
        child.stdout.on('data', chunk=>{
          output += chunk.toString();
          if (output.includes('READY\n')) resolve();
        });
        child.on('error', reject);
        child.on('close', ()=>reject(new Error('child died before fsync: '+stderr)));
      }),
      new Promise((_,reject)=>{ timeout = setTimeout(()=>reject(new Error('child fsync boundary timeout: '+stderr)),5000); })
      ]);
    } finally { clearTimeout(timeout); }
    assert.equal(child.kill('SIGKILL'), true);
    assert.equal((await exit).signal, 'SIGKILL');
    assert.deepEqual(await store.load(), {nextOffset:100});
    assert.equal(JSON.parse(await readFile(path,'utf8')).nextOffset,100);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }
}));
