import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewHandler } from '../scripts/serve-preview.js';

async function withServer(task) {
  const root = await mkdtemp(join(tmpdir(), 'spool-preview-test-'));
  const server = createServer(createPreviewHandler({directory:root}));
  try {
    await mkdir(join(root,'src'));
    await writeFile(join(root,'index.html'),'<html>isolated-preview</html>');
    await writeFile(join(root,'src/app.js'), 'export default 1;');
    await writeFile(join(root,'vercel.json'), '{"unsafe":true}');
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    return await task('http://127.0.0.1:'+server.address().port, root);
  } finally {
    if (server.listening) await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true});
  }
}
test('health is truthful and discloses preview rather than production',()=>withServer(async u=>{
  const r=await fetch(u+'/healthz');
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{status:'preview',productionQualified:false});
}));
test('all human and studio deep links return shell, not a 404',()=>withServer(async u=>{
  for (const path of ['/','/start','/local-runner','/integrations','/developers','/studio/new','/studio/results']) {
    const r=await fetch(u+path);
    assert.equal(r.status,200,path);
    assert.match(await r.text(),/isolated-preview/);
    assert.match(r.headers.get('content-security-policy'),/connect-src 'none'/);
  }
}));
test('static module correct MIME, no API, no repo metadata or host config exposed',()=>withServer(async u=>{
  assert.match((await fetch(u+'/src/app.js')).headers.get('content-type'),/text\/javascript/);
  for (const path of ['/api','/package.json','/vercel.json','/secret.env','/src/nothing.js']) {
    assert.equal((await fetch(u+path)).status,404,path);
  }
}));
test('reject invalid methods and encoded path traversal',()=>withServer(async u=>{
  assert.equal((await fetch(u+'/studio/new',{method:'POST'})).status,405);
  assert.equal((await fetch(u+'/%2e%2e%5csecret')).status,400);
  assert.equal((await fetch(u+'/%00')).status,400);
}));
test('HEAD returns correct length but no body',()=>withServer(async u=>{
  const r=await fetch(u+'/studio',{method:'HEAD'});
  assert.equal(r.status,200);
  assert.equal(r.headers.get('content-length'),String(Buffer.byteLength('<html>isolated-preview</html>')));
  assert.equal(await r.text(),'');
}));

test('symlinks inside dist cannot leak files or directories from outside the static artifact',()=>withServer(async (u,root)=>{
  const outside = await mkdtemp(join(tmpdir(),'spool-preview-outside-'));
  try {
    await writeFile(join(outside,'private.html'),'OUTSIDE_DIST_SENTINEL');
    await symlink(join(outside,'private.html'),join(root,'src','escape.html'));
    await symlink(outside,join(root,'src','escape-folder'));
    for (const path of ['/src/escape.html','/src/escape-folder/private.html']) {
      const response = await fetch(u+path);
      assert.equal(response.status,404,path);
      assert.doesNotMatch(await response.text(),/OUTSIDE_DIST_SENTINEL/);
    }
  } finally {
    await rm(outside,{recursive:true,force:true});
  }
}));
