import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-static-boundary-'));
  try {
    await mkdir(join(dir, 'src', 'core'), {recursive:true});
    await writeFile(join(dir,'index.html'),'<script type="module" src="/src/app.js"></script>');
    await writeFile(join(dir,'src','app.js'),"import './core/ok.js';\n");
    await writeFile(join(dir,'src','core','ok.js'),'export const ok = true;\n');
    return await run(dir);
  } finally { await rm(dir,{recursive:true,force:true}); }
}
function validate(root) {
  return spawnSync(process.execPath,[resolve('scripts/check-static-distribution.js'),root],{encoding:'utf8'});
}
test('valid static browser module graph passes',async()=>{
  await fixture(async dir=>{
    const r=validate(dir);
    assert.equal(r.status,0,r.stderr);
    assert.match(r.stdout,/"staticBoundary":"PASS"/);
  });
});
test('rejects unresolved browser static import',async()=>{
  await fixture(async dir=>{
    await writeFile(join(dir,'src','app.js'),"import './core/missing.js';\n");
    const r=validate(dir);
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/Missing browser module/);
  });
});
test('rejects privileged Node-only connector tree',async()=>{
  await fixture(async dir=>{
    await mkdir(join(dir,'src','connectors'));
    await writeFile(join(dir,'src','connectors','private.js'),'export const secret = null');
    const r=validate(dir);
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/Privileged Node-only directory/);
  });
});
test('rejects sensitive private-key artifacts',async()=>{
  await fixture(async dir=>{
    await writeFile(join(dir,'release-private.pem'),'private');
    const r=validate(dir);
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/Sensitive or debug artifact/);
  });
});
test('rejects missing browser worker asset referenced through import.meta',async()=>{
  await fixture(async dir=>{
    await writeFile(join(dir,'src','app.js'),"new URL('./worker/absent.worker.js', import.meta.url);\n");
    const r=validate(dir);
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/Missing browser module/);
  });
});
test('permits WebCrypto guarded Node fallback used only outside browsers',async()=>{
  await fixture(async dir=>{
    await writeFile(join(dir,'src','app.js'),"if(globalThis.crypto?.subtle){ /* browser */ } else { await import('node:crypto'); }");
    const r=validate(dir);
    assert.equal(r.status,0,r.stderr);
  });
});

test('rejects Node-only experimental assurance source in public dist',async()=>{
  await fixture(async dir=>{
    await mkdir(join(dir,'src','assurance'));
    await writeFile(join(dir,'src','assurance','foundation.js'),"import {sign} from 'node:crypto';");
    const r=validate(dir);
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/Privileged Node-only directory/);
  });
});
