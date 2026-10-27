# syntax=docker/dockerfile:1
#
# SPOOL enterprise API image (v2 daemon).
#
# The daemon binds 127.0.0.1 only and validates the Host header against that
# loopback identity, so this image is intended to run beside a same-pod proxy
# (see helm/spool/templates/configmap-proxy.yaml). Do not change the bind address.

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 needs its install script to fetch the pinned prebuilt binary.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SPOOL_STATE_DIR=/var/lib/spool \
    SPOOL_DAEMON_PORT=8080
WORKDIR /app
COPY --from=dependencies --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root capabilities ./capabilities
COPY --chown=root:root src ./src
RUN install -d -o node -g node -m 0750 /var/lib/spool
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SPOOL_DAEMON_PORT||8080)+'/v2/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "src/daemon/spoold-v2-main.js"]
