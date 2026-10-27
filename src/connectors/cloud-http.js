import http from 'node:http';
import https from 'node:https';
import { SpoolError, fail } from '../core/errors.js';

/**
 * Node-native HTTP/HTTPS JSON transport helper for cloud connectors (Snowflake / BigQuery).
 * Avoids browser-facing global fetch to comply with SPOOL local-first static purity rules.
 *
 * The endpoint is plan-supplied, so the transport is bounded like any other
 * untrusted input: http(s) only, no embedded credentials, no cloud-metadata
 * addresses, a request deadline and a response ceiling.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const FORBIDDEN_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
  'fd00:ec2::254'
]);

function normalizedHost(url) {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
}

function isForbiddenHost(host) {
  return FORBIDDEN_HOSTS.has(host) ||
    /^169\.254\./.test(host) ||
    /^a9fe:/i.test(host) ||
    /^fe[89ab][0-9a-f]:/i.test(host);
}

function endpointUrl(value) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_CLOUD_HTTP_ENDPOINT', 'Cloud endpoint must be a non-empty http(s) URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('INVALID_CLOUD_HTTP_ENDPOINT', 'Cloud endpoint must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('INVALID_CLOUD_HTTP_ENDPOINT', 'Cloud endpoint must use http or https');
  if (url.username || url.password) fail('INVALID_CLOUD_HTTP_ENDPOINT', 'Cloud endpoint must not embed credentials');
  if (isForbiddenHost(normalizedHost(url))) {
    fail('CLOUD_HTTP_ENDPOINT_FORBIDDEN', 'Cloud endpoint must not target a link-local or cloud metadata address');
  }
  return url;
}

export function requestJson(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = endpointUrl(urlStr);
    const client = url.protocol === 'https:' ? https : http;
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
    const payload = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;

    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const tooLarge = size => new SpoolError('CLOUD_HTTP_RESPONSE_TOO_LARGE', `Cloud response exceeds the ${maxBytes}-byte ceiling`, { size, maxBytes });

    const req = client.request(url, {
      method: options.method || 'GET',
      timeout: timeoutMs,
      headers: {
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(options.headers || {})
      }
    }, res => {
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.resume();
        settle(reject, tooLarge(declared));
        req.destroy();
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) {
          const error = tooLarge(total);
          settle(reject, error);
          res.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        settle(resolve, {
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          json: async () => JSON.parse(data),
          text: async () => data
        });
      });
      res.on('error', error => settle(reject, error));
    });

    req.on('timeout', () => {
      const error = new SpoolError('CLOUD_HTTP_TIMEOUT', `Cloud endpoint did not respond within ${timeoutMs} ms`, { timeoutMs });
      settle(reject, error);
      req.destroy(error);
    });
    req.on('error', error => settle(reject, error));
    if (payload) req.write(payload);
    req.end();
  });
}
