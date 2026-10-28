# Kubernetes deployment

The Helm chart in `helm/spool` is the single source of truth. Nothing is
pre-rendered into this directory on purpose: the manifest must be generated from
the exact release commit that is being deployed, otherwise its
`SPOOL_RELEASE_COMMIT_SHA` would be a stale provenance claim.

## Why a proxy sidecar

`spoold-v2` refuses any listen address other than a loopback IP and validates the
`Host` header against `127.0.0.1:<port>` (`src/daemon/spoold-v2.js`). A Service
that pointed straight at the daemon would be rejected at the HTTP layer, so each
pod runs an `nginx-unprivileged` sidecar that listens on the pod network and
rewrites `Host` to the loopback identity. That keeps the daemon's "no network
surface of my own" invariant intact while still being reachable in-cluster.

State (enterprise registry, per-workspace migration directories, checkpoints) is
a single SQLite database set on one `ReadWriteOnce` volume. That is why the chart
pins `replicaCount: 1`, uses the `Recreate` strategy, and refuses to render with
more replicas. Horizontal scaling is not supported by this deployment model.

## Render and apply

```bash
# helm 3.16.4 (verified sha256 9bb114c12e530a7129fd3d78fc1784e813dd7a6e29e5f9b5af8bc83fd1066d36
# for helm-v3.16.4-windows-amd64.zip; use the matching platform archive)
export RELEASE_COMMIT=$(git rev-parse HEAD)
node scripts/check-deployment.js --write dist/spool-enterprise.yaml
kubectl apply -n spool -f dist/spool-enterprise.yaml
```

`scripts/check-deployment.js` renders the chart, lints it, proves that rendering
fails closed without a release commit and with more than one replica, and checks
the rendered objects keep the properties the daemon depends on (loopback-only
daemon, proxy Host rewrite, read-only root filesystems, dropped capabilities,
credential secret references, probes on real routes, NetworkPolicy). It needs a
real `helm` binary; without one it exits 2 with `EXTERNALLY_BLOCKED`.

## Required secret

Credentials are never templated:

```bash
kubectl -n spool create secret generic spool-daemon-secrets \
  --from-literal=SPOOL_DAEMON_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=SPOOL_APPROVAL_SIGNING_KEY="$(openssl rand -hex 32)"
```

## Image

Built from the repository `Dockerfile`. The build is **not** verified in this
environment (no usable Docker engine); see `engineering/completion/BLOCKERS.json`.
