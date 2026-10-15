import { verifyDeployedRelease } from './verify-deployed-release.js';

const baseUrl = process.argv[2] || process.env.SPOOL_URL;
const commit = process.argv[3] || process.env.EXPECTED_SHA;
if (!baseUrl || !commit) {
  throw new Error('Usage: node scripts/verify-cloudflare-deployment.js https://preview.pages.dev <40-character-SHA>');
}
const url = new URL(baseUrl);
if (url.protocol !== 'https:' || url.username || url.password) {
  throw new Error('Cloudflare release verification requires a credential-free HTTPS URL');
}
const origin = url.origin;
async function get(path) {
  const response = await fetch(new URL(path, origin), {
    redirect: 'error',
    headers: {'cache-control':'no-cache'},
    signal: AbortSignal.timeout(30000)
  });
  return {response, body:await response.text()};
}
const {response:home,body:html} = await get('/');
if (!home.ok || !/\/src\/app\.js/.test(html)) throw new Error('Homepage did not serve the expected SPOOL web app');
const csp = home.headers.get('content-security-policy') || '';
if (!csp.includes("connect-src 'none'") || !csp.includes("object-src 'none'")) {
  throw new Error('Security headers do not enforce the required CSP');
}
for (const [key,value] of [
  ['x-content-type-options','nosniff'],
  ['x-frame-options','DENY'],
  ['referrer-policy','no-referrer']
]) {
  if ((home.headers.get(key) || '').toLowerCase() !== value.toLowerCase()) {
    throw new Error('Invalid security response header: '+key);
  }
}
const hsts = home.headers.get('strict-transport-security') || '';
if (!/max-age=\d+/.test(hsts)) throw new Error('Missing HSTS on HTTPS');
for (const route of ['/studio/original','/studio/inspect','/studio/validate','/security','/services']) {
  const page = await get(route);
  if (!page.response.ok || !page.body.includes('/src/app.js')) {
    throw new Error('SPA deep-link failed on '+route);
  }
}
for (const asset of [
  '/src/cli/spool.js',
  '/src/connectors/postgres/connection.js',
  '/src/platform/secrets.js',
  '/src/daemon/spoold.js',
  '/src/execution/migration-runner.js'
]) {
  const result = await get(asset);
  const contentType = result.response.headers.get('content-type') || '';
  if (contentType.includes('javascript') || result.body.includes("from 'node:")) {
    throw new Error('Privileged Node-side source exposed at '+asset);
  }
}
const parity = await verifyDeployedRelease({baseUrl:origin,expectedCommit:commit});
console.log(JSON.stringify({status:'PASS',origin,commit:parity.commit,artifacts:parity.artifactCount,csp:true,restrictedPaths:5,deepLinks:5}));
