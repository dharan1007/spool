import http from 'node:http';
import https from 'node:https';

/**
 * Node-native HTTP/HTTPS JSON transport helper for cloud connectors (Snowflake / BigQuery).
 * Avoids browser-facing global fetch to comply with SPOOL local-first static purity rules.
 */
export function requestJson(urlStr, options = {}) {
  const url = new URL(urlStr);
  const client = url.protocol === 'https:' ? https : http;
  const payload = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;

  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: options.method || 'GET',
      headers: {
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(options.headers || {})
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          json: async () => JSON.parse(data),
          text: async () => data
        });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
