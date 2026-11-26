# check=error=true
# The migration image (PT-8c, ADR-0192): the Prisma CLI, its engines, the
# schema and the migrations, and nothing else. From the repository root:
#   docker buildx build --platform linux/amd64 -f packages/database/Dockerfile .
FROM node:22-trixie-slim@sha256:f0960f8dc047f358e3fb428f36ccba21732194fa5f0cac849f401e63e62fb9e6 AS build
ENV CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY . .
# No .env where Prisma reads one (TODO, "Keep a .env out").
RUN for f in .env packages/database/.env packages/database/prisma/.env; do \
      if [ -e "$f" ]; then echo "refusing to build: $f exists" >&2; exit 1; fi; \
    done
RUN pnpm install --frozen-lockfile --offline
# The CLI's six packages, each pattern matching one folder, so a renamed or
# duplicated package fails here; a new dependency of the CLI would leave a
# dead link, which the migrate-image job refuses. Then the link node runs.
RUN mkdir -p /out/node_modules/.pnpm \
 && for p in 'prisma@*' '@prisma+engines@*' '@prisma+engines-version@*' \
      '@prisma+debug@*' '@prisma+fetch-engine@*' '@prisma+get-platform@*'; do \
      set -- node_modules/.pnpm/$p; \
      if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then echo "refusing to build: $p is not one folder" >&2; exit 1; fi; \
      cp -a "$1" /out/node_modules/.pnpm/; \
    done \
 && set -- /out/node_modules/.pnpm/prisma@* \
 && ln -s ".pnpm/${1##*/}/node_modules/prisma" /out/node_modules/prisma
# Debian 13's OpenSSL 3 decides both engines; a 1.1 one could not load. The
# names are amd64's: another platform's engine is refused.
RUN e=/out/node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines; \
    { ls $e/schema-engine-debian-openssl-3.0.x $e/libquery_engine-debian-openssl-3.0.x.so.node \
   && ! find /out -name '*openssl-1.1.x*' | grep -q . ; } \
 || { echo "refusing to build: no debian-openssl-3.0.x engines alone (build linux/amd64)" >&2; exit 1; }

FROM node:22-trixie-slim@sha256:f0960f8dc047f358e3fb428f36ccba21732194fa5f0cac849f401e63e62fb9e6 AS runtime
# For a verified TLS connection to the database, if one is chosen.
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install --yes --no-install-recommends \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && test -s /etc/ssl/certs/ca-certificates.crt
# No update check or notice: the job runs with no way out but the database.
ENV CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt SSL_CERT_DIR=/etc/ssl/certs
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
# Two lines: one COPY of both would put the migrations' folders beside the
# schema, and Prisma would then find none and pass (PT-8 critique, item 4).
COPY packages/database/prisma/schema.prisma ./prisma/schema.prisma
COPY packages/database/prisma/migrations ./prisma/migrations
USER 1000:1000
# migrate deploy by default; another command replaces it (`migrate status`).
ENTRYPOINT ["node", "/app/node_modules/prisma/build/index.js"]
CMD ["migrate", "deploy", "--schema", "/app/prisma/schema.prisma"]
