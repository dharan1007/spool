import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { metricsHandler } from '../observability/prometheus.js';
import { healthHandler, readyHandler } from '../observability/health.js';
import { verifyApiKey } from '../platform/api-keys.js';

export function createSpoolDaemonV2({ service, token, apiKeyStore = new Map(), host = '127.0.0.1', maxBodyBytes = 1024 * 1024 } = {}) {
  const expectedTokenBuffer = typeof token === 'string' && token.length >= 32 ? Buffer.from(token) : null;

  function authenticate(req) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const provided = authHeader.slice(7);
      if (expectedTokenBuffer && provided.length === expectedTokenBuffer.length) {
        try {
          if (timingSafeEqual(Buffer.from(provided), expectedTokenBuffer)) return { type: 'bearer' };
        } catch {}
      }
    }
    const apiKeyHeader = req.headers['x-api-key'];
    if (apiKeyHeader && typeof apiKeyHeader === 'string') {
      for (const [hash, meta] of apiKeyStore.entries()) {
        if (verifyApiKey(apiKeyHeader, hash)) return { type: 'apikey', meta };
      }
    }
    return null;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Public health & metrics routes
    if (req.method === 'GET' && pathname === '/v2/health') {
      return healthHandler(req, res);
    }
    if (req.method === 'GET' && pathname === '/v2/ready') {
      return readyHandler(req, res, { checkDb: () => service.history({ limit: 1 }) });
    }
    if (req.method === 'GET' && pathname === '/v2/metrics') {
      return metricsHandler(req, res);
    }

    // Authenticated routes
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authentication credentials' } }));
    }

    if (req.method === 'GET' && pathname === '/v2/migrations') {
      try {
        const list = service.history({});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, result: list }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: String(error?.message ?? error) } }));
      }
    }

    // Fallback not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: `Route ${req.method} ${pathname} not found` } }));
  });

  return server;
}
