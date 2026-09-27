import { createHash, timingSafeEqual } from 'node:crypto';

// Explicit loopback-only bearer → principal mapping. This does NOT implement
// enterprise OIDC/mTLS, tenant resource authorization, or multi-person approval.
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function compileLocalAuthorities(identities, allowedCommands) {
  if (!Array.isArray(identities) || identities.length < 1 || identities.length > 32) {
    throw new TypeError('localIdentities must contain 1..32 operator identities');
  }
  if (!(allowedCommands instanceof Set) || allowedCommands.size === 0) {
    throw new TypeError('A nonempty command registry is required');
  }
  const seenPrincipals = new Set();
  const seenTokens = new Set();
  const records = identities.map(identity => {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      throw new TypeError('Each local identity must be an object');
    }
    const { token, principal, commands } = identity;
    if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') < 32 || Buffer.byteLength(token, 'utf8') > 4096) {
      throw new TypeError('Local identity bearer token must be at least 32 bytes');
    }
    if (typeof principal !== 'string' || !PRINCIPAL.test(principal)) {
      throw new TypeError('Local identity principal must be a bounded identifier');
    }
    if (!Array.isArray(commands) || commands.length === 0
      || commands.some(command => typeof command !== 'string' || !allowedCommands.has(command))
      || new Set(commands).size !== commands.length) {
      throw new TypeError('Local identity commands must be a nonempty unique allowlist');
    }
    const digest = hashToken(token);
    const hex = digest.toString('hex');
    if (seenPrincipals.has(principal) || seenTokens.has(hex)) {
      throw new TypeError('Duplicate local identity principal or bearer credential');
    }
    seenPrincipals.add(principal);
    seenTokens.add(hex);
    return Object.freeze({ principal, tokenDigestHex: hex, commands: Object.freeze([...commands]) });
  });
  return Object.freeze(records);
}

export function authenticateLocalBearer(authorities, bearerHeader) {
  if (typeof bearerHeader !== 'string' || !bearerHeader.startsWith('Bearer ')) return null;
  const submittedToken = bearerHeader.slice(7);
  if (Buffer.byteLength(submittedToken, 'utf8') > 4096) return null;
  const submittedDigest = hashToken(submittedToken);
  let authenticated = null;
  // Check all identities without an early match-dependent short circuit.
  for (const identity of authorities) {
    if (timingSafeEqual(submittedDigest, Buffer.from(identity.tokenDigestHex, 'hex'))) authenticated = identity;
  }
  return authenticated;
}

export function assertLocalCommandAuthority(identity, body) {
  if (!identity || !body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Local caller and command body are required'), { code: 'LOCAL_AUTHORITY_REQUIRED' });
  }
  if (!identity.commands.includes(body.command)) {
    throw Object.assign(new Error('Local caller is not permitted to execute this command'), { code: 'COMMAND_FORBIDDEN' });
  }
  // A signed approval bound to a request.principal is meaningless when the
  // caller can simply choose that principal. Never rewrite it silently.
  if (Object.prototype.hasOwnProperty.call(body, 'request')) {
    const request = body.request;
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.principal !== identity.principal) {
      throw Object.assign(new Error('Command principal does not match authenticated caller'), { code: 'PRINCIPAL_MISMATCH' });
    }
  }
  return identity.principal;
}
