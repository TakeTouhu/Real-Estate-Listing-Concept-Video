# check=error=true
# The web app's production image (RD-10a, ADR-0175). From the repository
# root: docker buildx build --platform linux/amd64 -f apps/web/Dockerfile .
FROM node:22-trixie-slim@sha256:f0960f8dc047f358e3fb428f36ccba21732194fa5f0cac849f401e63e62fb9e6 AS build
ENV CI=1 NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY . .
# No .env where `prisma generate` runs (TODO, "Keep a .env out"), nor in
# apps/web, whose .env and .env.production `next build` copies into the image.
RUN for f in .env packages/database/.env packages/database/prisma/.env apps/web/.env*; do \
      if [ -e "$f" ]; then echo "refusing to build: $f exists" >&2; exit 1; fi; \
    done
RUN pnpm install --frozen-lockfile --offline
# Debian 13's OpenSSL 3 decides Prisma's engine; a 1.1 one could not load.
# The name is amd64's: another platform's engine is refused.
RUN { find node_modules/.pnpm -path '*/.prisma/client/*' \
        -name 'libquery_engine-debian-openssl-3.0.x.so.node' | grep -q . \
   && ! find node_modules/.pnpm -path '*/.prisma/client/*' \
        -name 'libquery_engine-debian-openssl-1.1.x.so.node' | grep -q . ; } \
 || { echo "refusing to build: no debian-openssl-3.0.x engine alone (build linux/amd64)" >&2; exit 1; }
# NODE_ENV unset: next build fixes it at production, HSTS included.
RUN env -u NODE_ENV pnpm --filter @app/web build

FROM node:22-trixie-slim@sha256:f0960f8dc047f358e3fb428f36ccba21732194fa5f0cac849f401e63e62fb9e6 AS runtime
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install --yes --no-install-recommends \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && test -s /etc/ssl/certs/ca-certificates.crt
# HOSTNAME: Docker sets the container's id, which server.js would bind.
# The two names: set before any client exists (TODO "Set the two names").
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 \
    PORT=3000 SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/certs
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER 1000:1000
EXPOSE 3000
# NEXT_PHASE naming the build would skip the start check (ADR-0151).
ENTRYPOINT ["/usr/bin/env", "-u", "NEXT_PHASE", "node", "apps/web/server.js"]
