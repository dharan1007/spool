import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { SpoolError, fail } from '../core/errors.js';

/**
 * Node-native HTTP/HTTPS JSON transport helper for cloud connectors (Snowflake / BigQuery).
 * Avoids browser-facing global fetch to comply with SPOOL local-first static purity rules.
 *
 * The endpoint is plan-supplied, so the transport is bounded like any other
 * untrusted input:
 *
 * - http(s) only, no embedded credentials, no fragment, bounded URL length;
 * - cloud metadata services and link-local / unspecified / multicast / reserved
 *   addresses are always refused and cannot be enabled by configuration;
 * - loopback and private (RFC1918, CGNAT, IPv6 ULA) addresses are refused by
 *   default. A legitimate private endpoint must be named explicitly with
 *   `SPOOL_CLOUD_PRIVATE_ENDPOINT_HOSTS` (or `allowedPrivateHosts`), because the
 *   targetRef itself is untrusted data and must not grant its own access;
 * - hostnames are resolved through a guarded `lookup` that validates every
 *   resolved address at connection time and pins the chosen address, so a
 *   hostname that resolves to a forbidden address (or is re-bound between
 *   validation and connect) is refused;
 * - HTTP redirects are never followed: a 3xx is returned to the caller, which
 *   treats it as a failure, so a redirect cannot re-target the request;
 * - a request body ceiling, a response byte ceiling, an idle timeout and a total
 *   deadline bound both directions of the exchange.
 *
 * This is documented as bounded SSRF resistance, not complete SSRF protection:
 * see docs/THREAT_MODEL.md and docs/LIMITS.md.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;

// Cloud metadata services. Always refused, regardless of configuration.
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
  'fd00:ec2::254',
  'instance-data'
]);

const ALWAYS_FORBIDDEN = new Set(['linkLocal', 'unspecified', 'multicast', 'reserved', 'metadata']);
const CONFIGURABLE = new Set(['loopback', 'private']);

function normalizedHostname(url) {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%[0-9a-z._-]+$/i, '')
    .replace(/\.$/, '');
}

function ipv4Kind(address) {
  const [a, b, c] = address.split('.').map(part => Number.parseInt(part, 10));
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'linkLocal';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved';
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return 'reserved';
  if (a === 203 && b === 0 && c === 113) return 'reserved';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return 'public';
}

function embeddedIpv4(value) {
  const dotted = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function ipv6Kind(address) {
  const value = address.toLowerCase();
  if (value === '::') return 'unspecified';
  if (value === '::1') return 'loopback';
  const mapped = embeddedIpv4(value);
  if (mapped) return ipv4Kind(mapped);
  if (/^fe[89ab]/.test(value)) return 'linkLocal';
  if (/^f[cd]/.test(value)) return 'private';
  if (/^2001:db8/.test(value)) return 'reserved';
  if (/^ff/.test(value)) return 'multicast';
  return 'public';
}

/** Classifies an IPv4/IPv6 address, or returns `'name'` for a DNS name. */
export function classifyAddress(address) {
  const value = String(address ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/%[0-9a-z._-]+$/i, '');
  const version = isIP(value);
  if (version === 4) return ipv4Kind(value);
  if (version === 6) return ipv6Kind(value);
  return 'name';
}

/** Classifies an endpoint host as a known metadata host, an address kind, or `'name'`. */
export function classifyEndpointHost(host) {
  const value = String(host ?? '').toLowerCase().replace(/\.$/, '');
  if (METADATA_HOSTS.has(value)) return 'metadata';
  if (value === 'localhost' || value.endsWith('.localhost')) return 'loopback';
  return classifyAddress(value);
}

function normalizeHostEntry(entry) {
  const text = String(entry ?? '').trim().toLowerCase();
  if (!text) return null;
  const bracketed = text.match(/^\[([^\]]+)](?::(\d+))?$/);
  const value = bracketed ? (bracketed[2] ? `${bracketed[1]}:${bracketed[2]}` : bracketed[1]) : text;
  return value.replace(/\.$/, '') || null;
}

/**
 * Resolves the private-endpoint policy.
 *
 * `SPOOL_CLOUD_PRIVATE_ENDPOINT_HOSTS` is a comma-separated allowlist of
 * `host` or `host:port` entries. `SPOOL_CLOUD_ALLOW_PRIVATE_ENDPOINTS=1` is a
 * blanket opt-in for loopback/private targets and exists for disposable staging
 * roots; metadata and link-local addresses stay refused either way.
 */
export function resolveCloudEndpointPolicy(options = {}) {
  const hostEntries = [
    ...String(process.env.SPOOL_CLOUD_PRIVATE_ENDPOINT_HOSTS ?? '').split(','),
    ...(Array.isArray(options.allowedPrivateHosts) ? options.allowedPrivateHosts : [])
  ];
  const allowedPrivateHosts = new Set();
  for (const entry of hostEntries) {
    const normalized = normalizeHostEntry(entry);
    if (normalized) allowedPrivateHosts.add(normalized);
  }
  return Object.freeze({
    allowPrivateNetwork: options.allowPrivateNetwork === true || process.env.SPOOL_CLOUD_ALLOW_PRIVATE_ENDPOINTS === '1',
    allowedPrivateHosts,
    requireTls: options.requireTls === true || process.env.SPOOL_CLOUD_REQUIRE_TLS === '1'
  });
}

function privateHostAllowed(url, policy) {
  const host = normalizedHostname(url);
  if (!host) return false;
  if (policy.allowedPrivateHosts.has(host)) return true;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return policy.allowedPrivateHosts.has(`${host}:${port}`);
}

function forbidden(kind, url) {
  const target = normalizedHostname(url);
  if (ALWAYS_FORBIDDEN.has(kind)) {
    return new SpoolError('CLOUD_HTTP_ENDPOINT_FORBIDDEN',
      `Cloud endpoint must not target a ${kind === 'linkLocal' ? 'link-local' : kind} address${target ? ` (${target})` : ''}`,
      { host: target, addressKind: kind });
  }
  return new SpoolError('CLOUD_HTTP_ENDPOINT_FORBIDDEN',
    `Cloud endpoint resolves to a ${kind} address (${target}); add it to SPOOL_CLOUD_PRIVATE_ENDPOINT_HOSTS to allow this private endpoint explicitly`,
    { host: target, addressKind: kind });
}

function addressAllowed(kind, url, policy) {
  if (kind === 'public' || kind === 'name') return true;
  if (ALWAYS_FORBIDDEN.has(kind)) return false;
  if (!CONFIGURABLE.has(kind)) return false;
  return policy.allowPrivateNetwork || privateHostAllowed(url, policy);
}

/** Refuses a host/address combination according to the resolved policy. */
export function assertEndpointAllowed(url, policy = resolveCloudEndpointPolicy()) {
  const host = normalizedHostname(url);
  if (!host) fail('INVALID_CLOUD_HTTP_ENDPOINT', 'Cloud endpoint must include a hostname');
  const kind = classifyEndpointHost(host);
  if (kind === 'name') return { host, addressKind: kind };
  if (!addressAllowed(kind, url, policy)) throw forbidden(kind, url);
  return { host, addressKind: kind };
}

/**
 * Builds the `lookup` used for the connection. Every resolved address is
 * validated at connection time and the first permitted address is returned, so
 * the address that was validated is the address that is connected to.
 */
export function createGuardedLookup(url, policy = resolveCloudEndpointPolicy()) {
  return function guardedLookup(hostname, lookupOptions, callback) {
    dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) {
        callback(new SpoolError('CLOUD_HTTP_DNS_FAILED', `Cloud endpoint hostname could not be resolved: ${error.code ?? 'unknown error'}`, { host: String(hostname) }));
        return;
      }
      const resolved = Array.isArray(addresses) ? addresses : [addresses];
      if (!resolved.length) {
        callback(new SpoolError('CLOUD_HTTP_DNS_FAILED', 'Cloud endpoint hostname resolved to no address', { host: String(hostname) }));
        return;
      }
      for (const entry of resolved) {
        const kind = classifyAddress(entry.address);
        if (!addressAllowed(kind, url, policy)) {
          callback(forbidden(kind, url));
          return;
        }
      }
      // Node asks for the full address list when happy-eyeballs
      // (`autoSelectFamily`) is in play; every entry was validated above.
      if (lookupOptions?.all) {
        callback(null, resolved.map(entry => ({ address: entry.address, family: entry.family })));
        return;
      }
      const chosen = resolved[0];
      callback(null, chosen.address, chosen.family);
    });
  };
}

function endpointUrl(value, policy) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_CLOUD_HTTP_ENDPOINT', 'Cloud endpoint must be a non-empty http(s) URL');
  if (value.length > MAX_URL_LENGTH) fail('INVALID_CLOUD_HTTP_ENDPOINT', `Cloud endpoint exceeds the ${MAX_URL_LENGTH}-character limit`);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_CLOUD_HTTP_ENDPOINT', 'Cloud endpoint must not contain control characters');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('INVALID_CLOUD_HTTP_ENDPOINT', 'Cloud endpoint must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('INVALID_CLOUD_HTTP_ENDPOINT', 'Cloud endpoint must use http or https');
  if (policy.requireTls && url.protocol !== 'https:') fail('INVALID_CLOUD_HTTP_ENDPOINT', 'Cloud endpoint must use https when SPOOL_CLOUD_REQUIRE_TLS is set');
  if (url.username || url.password) fail('INVALID_CLOUD_HTTP_ENDPOINT', 'Cloud endpoint must not embed credentials');
  if (url.hash) fail('INVALID_CLOUD_HTTP_ENDPOINT', 'Cloud endpoint must not contain a fragment');
  assertEndpointAllowed(url, policy);
  return url;
}

export function requestJson(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const policy = resolveCloudEndpointPolicy(options);
    const url = endpointUrl(urlStr, policy);
    const client = url.protocol === 'https:' ? https : http;
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
    const maxRequestBytes = Number.isSafeInteger(options.maxRequestBytes) && options.maxRequestBytes > 0 ? options.maxRequestBytes : DEFAULT_MAX_REQUEST_BYTES;
    const payload = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;

    if (payload && Buffer.byteLength(payload) > maxRequestBytes) {
      fail('CLOUD_HTTP_REQUEST_TOO_LARGE', `Cloud request body exceeds the ${maxRequestBytes}-byte ceiling`, { maxRequestBytes });
    }

    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const tooLarge = size => new SpoolError('CLOUD_HTTP_RESPONSE_TOO_LARGE', `Cloud response exceeds the ${maxBytes}-byte ceiling`, { size, maxBytes });
    const timedOut = () => new SpoolError('CLOUD_HTTP_TIMEOUT', `Cloud endpoint did not respond within ${timeoutMs} ms`, { timeoutMs });

    const req = client.request(url, {
      method: options.method || 'GET',
      timeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
      lookup: createGuardedLookup(url, policy),
      headers: {
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(options.headers || {})
      }
    }, res => {
      // Redirects are never followed; a 3xx reaches the caller as a failed response.
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
      const error = timedOut();
      settle(reject, error);
      req.destroy(error);
    });
    req.on('error', error => {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        settle(reject, timedOut());
        return;
      }
      settle(reject, error);
    });
    if (payload) req.write(payload);
    req.end();
  });
}
