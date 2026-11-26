# API Changes — RD-10c

The worker has a container image of its runtime layer: the pinned base,
Debian 13's FFmpeg and the six disclosure images, with no worker code.
A new CI job builds it on every push and pull request, runs the media
suites on its FFmpeg and pushes nothing (ADR-0176). The composer states
its output frame rate, so masters keep their length on every FFmpeg
measured; Debian 13's 7.1.5 is measured by this pull request's CI
(ADR-0176 Decision 8). **No migration, no dependency, no
route and no new setting.** RD-10 is complete with it.

## HTTP

None changed.

## The image

`apps/worker/Dockerfile`, built from the repository root:

| Stage | What it does |
| --- | --- |
| `ffmpeg` | `node:22-trixie-slim` by ADR-0175's digest; Debian's `ffmpeg` without recommends, its version floating within Debian 13 |
| `media-test` | CI only, as root: the repository installed from the lockfile, offline after `pnpm fetch`; its command runs `vitest.media.config.ts` |
| `runtime` | the six `layer-v1-*.png` at `/app/assets/disclosure`, their list at `/app/assets/disclosure.sha256`, `worker-image-check`; root's by COPY's default (inferred; CI checks it); `USER 1000:1000` |

The image adds no name to the base's environment. Its command writes
"The worker has no production runtime until part 2 (ADR-0151 Decision
4)." to standard error and exits 2; its entrypoint is the base's
`docker-entrypoint.sh`. It has no `HEALTHCHECK`, no build argument and
no font of its own (FFmpeg's dependencies may bring one, unused;
inferred). `worker-image-check` requires the first lines of
`ffmpeg -version` and `ffprobe -version` to name the series `7.1`,
FFmpeg's `libx264` encoder by name, `sha256sum --check --strict` of the
list, and as many entries in the directory as the list names, a dotfile
counted too; it exits 1 at the first refusal.
`apps/worker/Dockerfile.dockerignore` holds exactly the lines the web
image's ignore file must hold, and no other.

## Environment

None added or changed.

## Internal API

`packages/storage/src/managed-output/ffmpeg-composer.ts`: the Clean
Master's and the customer's video's argument vectors carry `-r N/D`,
the profile's frame rate, before `-c:v` (ADR-0176 Decision 8). No
signature, filter or other argument changed. Composition stays dormant.

## Logs

None changed.

## Tests and CI

`tests/container-images.test.ts` now lists the worker's Dockerfile, so
every rule of ADR-0175 Decision 3 holds for it, and adds: the worker's
three stages word for word; its ignore file of exactly the required
lines; `check.sh` executable in the checkout and held word for word
but its comments, and run under `/bin/sh` against stand-in `ffmpeg` and
`ffprobe` with its `/app` moved to a temporary folder: it passes 7.1
with `libx264` and refuses 6.1.1, 7.10.1, an `ffprobe` of another
series, `libx264rgb` alone, and a changed, missing or seventh image or
a dotfile; `disclosure-layers.sha256` equal to
`DISCLOSURE_LAYER_ASSETS` line for line and to the committed files'
SHA-256, and the files `layer-v1-*.png` matches exactly the listed
ones; and the `worker-image` job held as the `web-image` job is (its
keys, `contents: read`, only `actions/checkout`, each build word for
word, no `if:` of its own), with every step's name, time limit and
whole `run:` text. Each image's builds are read in their own job;
Docker anywhere else in the workflow still fails it. The composer's two
exact argument-vector unit tests gain `-r 30/1`, and a new one holds
that `-r` is the profile's fraction, before `-c:v`, on both encodes.

New CI job `worker-image` (`ubuntu-24.04`, 30 minutes,
`contents: read`): it builds `media-test`, prints its FFmpeg's version
and runs it with `--network none --cap-drop ALL --security-opt
no-new-privileges` (15 minutes); builds the image (the builds 20 and 10
minutes); requires every layer below the image's own three to be
`media-test`'s; requires user `1000:1000`, `id -u` `1000`, every file
under `/app` and the check root's and not writable by others, the
base's entrypoint and no proxy in its environment; runs
`worker-image-check` and the default with `--network none --read-only
--cap-drop ALL --security-opt no-new-privileges`, the default to exit 2
with its sentence (2 minutes each); then prints the packages, Node.js's
version and the size. A pull request shows 14 checks. The `media` job
is unchanged; the `web-image` job's build step gets a 20-minute limit
too.

Where this differs from the RD-10 design (`critic.md` §3 and §4): no
`--chmod` (ADR-0175 refuses it; Git's `100755` is tested instead), the
refusal through `/bin/sh -c` instead of `node -e`, no `--check` step,
and the layer comparison, the `ffprobe` series, the file count, the
files' owner check, the step limits and the exact ignore file added
(ADR-0176, "Where this differs").

Measured here: the checksums, `check.sh` under `dash` against a
stand-in FFmpeg for its pass and every refusal (by hand and in the
guard test), and the suites on this host's FFmpeg 6.1.1; with `-r`, the
suites on FFmpeg 6.1.1, 7.0.2 and 9.0.2 (172 of 172 each). Not measured
here: any build of the image, since no Docker daemon ran and Debian's
mirror was not reached. CI's first build ran the suites on Debian 13's
FFmpeg 7.1.5 and failed 22 of 172 before `-r`; the run with `-r` is
this pull request's next.
