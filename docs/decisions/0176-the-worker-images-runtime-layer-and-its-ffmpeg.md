# ADR-0176 — The worker image's runtime layer and its FFmpeg

Status: Accepted (RD-10c, 2026-11-25; Decision 8 added 2026-11-26,
before merge). The third and last part of the
tenth milestone of production readiness, part 1, which the product
owner approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`, design item
7 and PR-10). ADR-0175 reserved this number for the worker image. It
decides what the worker's image carries before the worker has a
production runtime, which FFmpeg it carries, and how CI proves that
FFmpeg. Decisions 1 to 6 and 8 are built here; Decision 7 is part
2's.

Builds on: ADR-0175 (every image's rules, its base and digest, CI
builds and pushes nothing), ADR-0071 (the disclosure overlay is a
picture: no font, Decision 1), ADR-0072 (the media suites on real
FFmpeg; CI's own FFmpeg moves only with the runner's label, Decision
2), ADR-0075 Decision 3 (the composer takes the images' directory as an
absolute path), ADR-0081 (the runner suite's on-plan assertion),
ADR-0151 Decision 4 (the worker's start is checked with its runtime, in
part 2). Decision 8 adds one option to both of ADR-0075's encodes.
**Amends ADR-0072 Decision 6** (below, Decision 3).

## Context

The worker has no production runtime: its start file runs a provider
self-check and exits, and its start is checked with its runtime in part
2 (ADR-0151 Decision 4); every runner is assembled only in the
development pipeline, which refuses production; and `tsx`, which runs
both, is a development dependency. ADR-0072 Decision 6 left the
production FFmpeg undecided, and `TODO.md` asks that whichever build
the worker image ships run `pnpm test:media`, the runner suite
included, before it composes anything, and that the image carry the six
disclosure images. The RD-10 design (`/mnt/project-files/cto/rd-10/`,
`critic.md` C6 to C8, adopted by `decision.md`) chose an image of the
worker's runtime layer alone.

## Decision 1 — The image is the worker's runtime layer, with no code

`apps/worker/Dockerfile` builds an image of ADR-0175's base, FFmpeg
and the six disclosure images, and nothing of the worker's code or
packages: no production entry point exists to run them, and the
development dependencies they would bring prove nothing the web image
does not. Part 2 adds the code layer on the same FFmpeg stage when it
assembles the worker's runtime and its start check. The image keeps
every rule of ADR-0175 Decision 3, and `tests/container-images.test.ts`
lists it beside the web image's.

## Decision 2 — Debian 13's FFmpeg, floating within the release

A stage named `ffmpeg` installs Debian's `ffmpeg` package with
`--no-install-recommends` on the pinned base, from Debian's mirror,
retrying a download three times. Its version is not pinned: the base
digest fixes the release, Debian 13, within which Debian does not move
FFmpeg's series (inferred from Debian's stable practice), and an exact
version would fail every build once Debian's archive drops it. This is
ADR-0072 Decision 2's rule for CI's own FFmpeg. CI requires the series,
`7.1`, and `libx264` on every build, and prints every package the image
holds. No font is installed on purpose; one FFmpeg's dependencies bring
is unused (inferred).

## Decision 3 — The media suites run on that very FFmpeg (amends ADR-0072 Decision 6)

A stage named `media-test`, built on the `ffmpeg` stage, holds the
repository installed from the lockfile, offline after `pnpm fetch`, and
runs `vitest run --config vitest.media.config.ts`, which is
`pnpm test:media` without `pnpm`, so nothing fetches `pnpm` while it
runs with no network. CI runs it on every build; the runner suite's
on-plan assertion (ADR-0081) is among them. CI then requires every
layer of the image below its own three to be the `media-test` image's,
so the suites ran the FFmpeg the image carries. The stage runs as root,
in CI only, and never becomes the image.

ADR-0072 Decision 6 said which FFmpeg the worker image carries was a
deployment decision for when composition is activated. It is now
chosen, and its suites run; composition stays dormant, and nothing
gives the composer the images' directory until part 2. Its other half
stands: the suites run against the deployment's own FFmpeg before it
composes anything. CI's build is never pushed and FFmpeg floats, so
part 2 must deploy a build the suites ran on; nothing enforces that
yet, and nothing deploys. The `media` job's Ubuntu 24.04 FFmpeg
6.1.1, on which the tolerances were measured, keeps running the same
suites.

## Decision 4 — The six images and their checksums, no font

The image holds `assets/disclosure/layer-v1-*.png` at
`/app/assets/disclosure`, where the development assembly's relative
path lands when `/app` mirrors the repository, so part 2 adds the code
beside them unchanged. `apps/worker/image/disclosure-layers.sha256`,
copied to `/app/assets/disclosure.sha256`, names each by its absolute
path and SHA-256; a test holds it equal, line for line, to
`DISCLOSURE_LAYER_ASSETS` and to the committed files. The font subset,
its licence and `fonts.conf` stay out (ADR-0071 Decision 1). COPY
leaves the files root's (inferred from its default; CI checks it,
Decision 6), with the mode the builder's checkout gave them (664 in
this tree, 644 under umask 022), so the image's user reads them and
cannot write them.

## Decision 5 — The default refuses; the check is explicit

The image runs as `1000:1000`. Its `CMD` writes "The worker has no
production runtime until part 2 (ADR-0151 Decision 4)." to standard
error and exits 2, so the image runs no generation, loop or timer. It
sets no `ENTRYPOINT` of its own: the base's `docker-entrypoint.sh`
stays, and runs the given command. `worker-image-check`
(`apps/worker/image/check.sh`, POSIX `sh`, no pipe) is the explicit
check: the first lines of `ffmpeg` and `ffprobe -version` name the
series, FFmpeg lists the `libx264` encoder by name, `sha256sum --check
--strict` passes the list, and the directory holds as many entries as
the list names, a dotfile counted too; it exits 1 at the first
refusal. The script keeps the mode
Git gives it (`100755`), since ADR-0175 Decision 3 allows no `--chmod`
or `chmod`, and the guard test requires that mode.

## Decision 6 — What CI proves

The `worker-image` job (ADR-0175 Decision 1's shape, a second job, two
more checks on a pull request: 14) builds `media-test`, prints its
FFmpeg's version and runs it with `--network none --cap-drop ALL
--security-opt no-new-privileges`; builds the image; requires the
shared layers; requires user `1000:1000`, `id -u` `1000`, every file
under `/app` and the check root's and not writable by others (and
prints each one's owner and mode), the base's entrypoint and no proxy
in the environment, and prints the command and labels; runs
`worker-image-check` and the default with `--network none --read-only
--cap-drop ALL --security-opt no-new-privileges`, the default to exit 2
with its sentence; and prints the packages, Node.js's version and the
size. The builds stop at 20 and 10 minutes, the suites at 15. No step
waits in a loop. The guard test holds every step's name, time limit
and whole `run:` text, and runs `check.sh` against stand-in tools for
its pass and its refusals.

## Decision 7 — What part 2 adds

The worker's code and how it runs (`tsx` or a bundle), the two
certificate names and `ca-certificates`, its start check, a writable
`/tmp` (the composer writes there), passing `/app/assets/disclosure` as
the composer's directory, and the dormancy guards' amendment for a
production FFmpeg launch. Composition's activation also waits on
FFmpeg's licensing question (GPL, H.264), which is counsel's;
`TODO.md` records it with the counsel review.

## Decision 8 — Both encodes state their output rate

CI's first build of this image ran the media suites on Debian 13's
FFmpeg `7.1.5-0+deb13u1`: 150 of 172 passed. The Clean Master had the
105 frames of a 3.5 s scene at 30 fps, but ffprobe measured it 3,467 ms
long with an average rate of `105000000/3466667`, so the inspector
called it unusable, and 22 tests failed (18 composer, 4 runner).
FFmpeg 6.1.1 gives 30/1 and 3,500 ms from the same arguments.

The composer's two argument vectors (ADR-0075 Decisions 1 and 2) now
carry `-r N/D`, the profile's frame rate, before `-c:v`. Without it
FFmpeg takes the encoder's rate from the filter graph's output, which
states none, and releases fill that gap differently (below). With it,
on every build measured here, the encoder's time base is the profile's,
every frame lasts one period and the last is counted in the length;
that 7.1.5 does the same is inferred until this pull request's CI
measures it. No filter, media-suite expectation or tolerance changed,
and no media suite was relaxed; the two exact argument-vector unit
tests gained `-r 30/1`, and one more asserts the option follows the
profile on both encodes.

The product owner chose, on 2026-11-26 at 00:14Z (a decision card in
the project thread), to fix the composer's arguments rather than hold
RD-10c. The card said the fix would merge as its own pull request first
and be checked on FFmpeg 7.1 here. Both changed: the fix rides in this
pull request, because this work may push only one branch and #216 is
on it, which also lets the `worker-image` job measure the fix on
Debian's own 7.1.5 before anything merges; and no 7.1 build could be
had here (PyPI's builds are 7.0.2 and 9.0.2). The CTO told the owner
both.

## What was measured

For Decision 8, on this host with no Docker: from the composer's own
graph, FFmpeg 6.1.1 (Ubuntu's) gave 30/1 and 3.500 s either way; a
static FFmpeg 7.0.2 gave 25/1, 88 frames and 3.520 s without `-r` and
30/1, 105 frames and 3.500 s with it; a static FFmpeg 9.0.2 gave 30/1
and 3.500 s either way. With `-r`, `pnpm test:media` passed (172 of
172) on 6.1.1, 7.0.2 and 9.0.2, probed by ffprobe 6.1.1 (the static
builds came from PyPI's `imageio-ffmpeg`, which ships no ffprobe). No
7.1 build was available here: whether 7.1.5 passes is CI's measurement
on this pull request. A simulation points the same way (inferred, not a
7.1 measurement): FFmpeg 7.0.2 told `-fps_mode vfr` in place of `-r`
wrote CI's exact symptom, a 1000000 time scale, a 3,466,667 length, a
last packet with no duration, and the media suites then failed 22 of
172 (18 composer, 4 runner), CI's split; and FFmpeg 6.1.1, 7.0.2 and
9.0.2 each refuse `-r` together with `-fps_mode vfr` as contradictory,
so a stated rate encodes at a constant one.

For the image, here, with no Docker daemon running (none was started)
and Debian's mirror not reached: the six images' SHA-256 equal
`DISCLOSURE_LAYER_ASSETS`; `check.sh`, its `/app` moved under a
stand-in folder, passed under `dash` with a stand-in `ffmpeg` and
`ffprobe` printing a `7.1.1-1+b1` banner, and refused each of: series
6.1.1, 7.10.1 and 8.0, an `ffprobe` of another series, a failing
`-version` or `-encoders`, `libx264rgb` without `libx264`, an altered,
missing or seventh image, and a malformed list line. With this host's
real FFmpeg 6.1.1 it refused the series, and passed with the series set
to `6.1` in a copy. `pnpm test:media` passed on that FFmpeg 6.1.1.
The guard test runs `check.sh` the same way under `/bin/sh` (`dash`
here): it passes a `7.1.2` stand-in and refuses 6.1.1, 7.10.1, an
`ffprobe` of another series, `libx264rgb` alone, and a changed, missing
or seventh image or a dotfile.

**Not measured here**: `docker buildx build`, Debian 13's FFmpeg and
its series, the media suites on it, and the image. The first build is
CI's; its 22 failures went back to the CTO, and the product owner
chose fixing the composer's arguments (Decision 8) over holding RD-10c;
no tolerance moved: a re-measured tolerance would be an amendment of
ADR-0072, never a silent loosening.

## Where this differs from the RD-10 design

- **No `--chmod`** on `check.sh` (the design's sketch): ADR-0175
  Decision 3 and its guard refuse it, so the mode is Git's and tested.
- **The refusal runs `/bin/sh -c`**, not `node -e`: the same sentence
  and exit code in a line under 120 columns.
- **No `--check` step**, as in ADR-0175's job: `# check=error=true`
  already fails the build on any warning.
- **Each file's owner and mode are checked** in CI, the builds carry
  step time limits, and the worker's ignore file must be exactly the
  required lines, so no media suite can be left out of the stage.
- **A layer comparison** proves the suites ran the image's FFmpeg; the
  design relied on the shared stage alone.
- **`ffprobe`'s series and the file count** are checked too, and
  `libx264` is matched as the encoder's name, since `libx264rgb`'s line
  also says `libx264`.

## Consequences

- A pull request shows 14 checks; the merge rule stays "every check
  green". The job adds Debian's FFmpeg download and the media suites'
  encodes to every push and pull request (a few minutes, inferred).
- A Debian point release that moves FFmpeg within 7.1 reaches CI's
  image at its next build and is proved by the suites there; a deployed
  image is held to Decision 3. A base digest bump that moved the series
  fails the check, and is the CTO's.
- The image is not runnable as a worker; whoever deploys it before part
  2 gets exit 2.
- The customer's video and the Clean Master are encoded with an
  explicit rate on every FFmpeg; on 6.1.1 the suites measure the same
  results as before.
- For the product owner, nothing to decide; told: CI takes longer, and
  FFmpeg's licensing is a counsel question before composition is
  activated.
