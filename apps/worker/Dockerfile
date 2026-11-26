# check=error=true
# The worker's runtime layer (RD-10c, ADR-0176): the pinned base, Debian 13's
# FFmpeg and the six disclosure images, with no worker code until part 2.
# From the repository root:
#   docker buildx build --platform linux/amd64 -f apps/worker/Dockerfile .
FROM node:22-trixie-slim@sha256:f0960f8dc047f358e3fb428f36ccba21732194fa5f0cac849f401e63e62fb9e6 AS ffmpeg
# Debian's own FFmpeg, floating within the release the digest fixes; no font
# of its own (one its dependencies may bring is unused; inferred).
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install --yes --no-install-recommends \
      ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# CI only: the media suites against this very FFmpeg (ADR-0072), never the
# image. Vitest runs directly, so nothing fetches pnpm when it runs offline.
FROM ffmpeg AS media-test
ENV CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --frozen-lockfile --offline
CMD ["node_modules/.bin/vitest", "run", "--config", "vitest.media.config.ts"]

# The image: the six images where the development assembly's relative path
# lands when /app mirrors the repository, their checksums and the check.
# check.sh keeps the mode Git gives it (100755); COPY leaves the files root's,
# which CI checks.
FROM ffmpeg AS runtime
COPY assets/disclosure/layer-v1-*.png /app/assets/disclosure/
COPY apps/worker/image/disclosure-layers.sha256 /app/assets/disclosure.sha256
COPY apps/worker/image/check.sh /usr/local/bin/worker-image-check
USER 1000:1000
# No worker runs here: the default refuses (ADR-0151 Decision 4).
CMD ["/bin/sh", "-c", "echo 'The worker has no production runtime until part 2 (ADR-0151 Decision 4).' >&2; exit 2"]
