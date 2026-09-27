# Strict local migration scopes

SPOOL's loopback daemon supports `requireMigrationScopes: true` for a
fail-closed *local* operator deployment. It does not turn the daemon into a
public network service or provide enterprise identity federation.

```js
import { createSpoolDaemon } from '../src/daemon/spoold.js';

const daemon = createSpoolDaemon({
  service, // your initialized SpoolCommandService
  host: '127.0.0.1',
  requireMigrationScopes: true,
  localIdentities: [
    {
      token: process.env.SPOOL_OPERATOR_A_TOKEN,
      principal: 'operator:alice',
      commands: ['inspect', 'plan', 'status', 'approve', 'run', 'receipt'],
      migrationIds: ['preprovisioned-migration-A']
    },
    {
      token: process.env.SPOOL_OPERATOR_B_TOKEN,
      principal: 'operator:bob',
      commands: ['inspect', 'plan', 'status', 'receipt'],
      migrationIds: ['preprovisioned-migration-A']
    }
  ]
});
```

Each token must be a separate high-entropy secret at least 32 UTF-8 bytes long;
do not embed it in a repository, URL, browser, or client-side bundle. Never
configure the legacy shared `token` simultaneously with `localIdentities`.
Startup fails if any strict identity has no explicit, nonempty migration
allowlist. A matching bearer cannot execute ungranted commands, impersonate
another `request.principal`, inspect another migration ID, or invoke a
top-level cutover/status endpoint with a different migration ID. Mismatched
`request.migrationId` and `migrationId` fail before dispatch. The API
responds 403, with no corresponding command-service invocation.

**Security boundary:** This is exact migration-ID authorization for one
loopback process, *not* tenant data-source isolation. SPOOL's migration IDs and
plan connection references may be supplied by callers; protecting customer
data requires a separately trusted binding from each identity to immutable
source and target resource identities. This setting does not implement
OIDC/JWT verification, mTLS, global session revocation, approval separation
between distinct humans, audit log export, or distributed role administration.
The signed plan/repair approval record still binds to one request principal.
For now a working local approve-and-run path needs that same bound principal,
so the example grants Alice both commands. Bob's read-only identity illustrates
migration-scoped visibility; it is **not** a second approving authority.
Do **not** interpret separate `approve` and `run` grants as a completed
two-person authorization workflow.

Legacy single-token mode is retained for backwards compatibility and remains
**unsuitable as proof of enterprise authorization**. Enable strict mode for
scoped local operation only; production enterprise release remains gated on
independent identity, policy, and separation-of-duties validation.
