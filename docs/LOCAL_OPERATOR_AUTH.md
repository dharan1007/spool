# SPOOL loopback operator identities (development-only)

The local HTTP daemon remains bound to `127.0.0.1` or `::1`. The historical
`token` option is a single bearer that does **not** authenticate the
`request.principal` supplied by a caller. Do not expose that mode to
untrusted operators or describe it as enterprise authorization.

For an explicitly scoped, loopback-only development daemon, provision
**distinct, cryptographically random** secrets through your environment
and use the `localIdentities` option instead of `token`:

```js
createSpoolDaemon({
  service,
  localIdentities: [
    {
      token: process.env.SPOOL_OPERATOR_TOKEN,
      principal: 'operator:local',
      commands: ['plan', 'run', 'status', 'receipt']
    }
  ]
});
```

Every request must authenticate with the exact bearer and, when it carries
a `request` object, `request.principal` must match the server-provisioned
identity. Unknown/missing credentials fail with 401; disallowed commands
or forged principals fail with 403 **before the command service is called**.
Each identity has an immutable command allowlist. Multiple identities cannot
reuse the same bearer or principal. There is no fallback from this mode to
the legacy super-bearer.

**Boundaries:** This is a hardening for a *local* bearer-token transport, not
OIDC, mTLS, SSO, SCIM, a tenant-scoped policy engine, or genuine two-person
approval. It does not authorize resources such as a `migrationId` and it
does not prevent a person with access to both bearer tokens from acting as
both identities. The command service's approval model still requires an
independent actor-set and revocation redesign before enterprise operation.
Do not expose the daemon through a public reverse proxy. Provision and
rotate tokens outside the repository; never store real tokens in examples,
browser storage, release bundles or logs.

Regression checks: `tests/local-authority.test.js` and
`tests/spoold-bound-authority.test.js` (both automatically included by
`npm test`). Those focused tests are not a substitute for real customer
identity, multi-tenant authorization, penetration tests or the mandatory
PostgreSQL integration gates.
