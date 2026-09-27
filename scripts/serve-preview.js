#!/usr/bin/env node
// Isolated, static-only SPOOL candidate preview. No command execution, no DB,
// no cookies or secrets, and no exposure of the source repository outside dist.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, sep, extname } from 'node:path';

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
});
const SPA_ROUTES = new Set([
  '/', '/start', '/integrations', '/developers', '/local-runner',
  '/examples', '/security', '/services', '/autopilot', '/how-it-works',
  '/webmcp', '/benchmarks', '/docs', '/studio', '/studio/new',
  '/studio/mission', '/studio/results'
]);
const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  'cache-control': 'no-store'
});

export function createPreviewHandler({ directory = 'dist' } = {}) {
  const root = resolve(directory);
  return async (request, response) => {
    const headers = { ...SECURITY_HEADERS };
    function respond(code, body = '', type = 'text/plain; charset=utf-8') {
      response.writeHead(code, { ...headers, 'content-type': type, 'content-length': Buffer.byteLength(body) });
      response.end(request.method === 'HEAD' ? undefined : body);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      respond(405, 'Method not allowed');
      return;
    }
    if (request.url === '/healthz') {
      respond(200, '{"status":"preview","productionQualified":false}', CONTENT_TYPES['.json']);
      return;
    }
    let pathname;
    try {
      const url = new URL(request.url ?? '', 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
      if (url.search || url.hash || pathname.includes('\\') || pathname.includes('\0') || pathname.includes('..')) {
        throw new Error('Unsafe preview path');
      }
    } catch {
      respond(400, 'Invalid path');
      return;
    }
    const route = pathname.replace(/\/+$/, '') || '/';
    const servedPath = SPA_ROUTES.has(route) ? '/index.html' : pathname;
    const suffix = extname(servedPath);
    if (servedPath === '/vercel.json' || !Object.hasOwn(CONTENT_TYPES, suffix)) {
      respond(404, 'Not found');
      return;
    }
    const file = resolve(root, '.' + servedPath);
    const rel = relative(root, file);
    if (rel.startsWith('..' + sep) || rel === '..' || rel.startsWith(sep)) {
      respond(404, 'Not found');
      return;
    }
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('Not a regular file');
      const body = await readFile(file);
      response.writeHead(200, { ...headers, 'content-type': CONTENT_TYPES[suffix], 'content-length': body.length });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      respond(404, 'Not found');
    }
  };
}

if (process.argv[1] && process.argv[1].endsWith('serve-preview.js')) {
  const port = Number(process.env.PORT ?? 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a TCP port');
  const server = createServer(createPreviewHandler({ directory: process.env.SPOOL_DIST_DIR || 'dist' }));
  server.listen(port, '0.0.0.0', () => {
    console.log(`SPOOL static preview active on port ${port}; NOT_PRODUCTION_QUALIFIED`);
  });
}
