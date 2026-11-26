# ADR-0180 — Each image is scanned in its own job

Status: Accepted (PT-6b, 2026-11-26). A milestone of production
readiness, part 2, approved by the product owner on 2026-11-26 at
04:38Z (`docs/production-readiness-part2-gap-analysis.md`). "What was
measured" is filled from the first CI run before merge.
**Amends ADR-0175 Decisions 2 and 8.** ADR-0175 Decision 1 is unchanged:
no new action, and nothing pushed, logged in to, cached or put on a
timed trigger.

Builds on: ADR-0175 (the image jobs, the pinned base, the inventory
CI prints), ADR-0176 (the worker image's job), ADR-0178 (the confined
`docker run` flags its stand-ins use, reused here), ADR-0179 (one run
per commit; still 8 checks).

## Context

ADR-0175 Decision 8 ran no scanner in part 1 and left "choosing a
scanner and an SBOM format" to part 2. Each image job prints its Debian
packages and its Node.js version, and nothing reads that list. PT-6c
moved `sharp` to 0.35.5 and lifted `nanoid` and `source-map-js`, so
`pnpm audit --prod` holds 8 findings, none critical (`TODO.md`, "Open
in RD-10"). The Debian packages of the pinned base, the base image's
own npm and Node.js itself were never matched against any advisory.

Third-party actions in this workflow are pinned by tag, not by commit;
only images are pinned by digest. A scanner brought in as an action
would be the image jobs' first third-party action.

## Decision 1 — Syft and Grype, as images pinned by digest

Syft writes the image's SBOM; Grype matches it against its database.
Both run as their published images, pinned by tag and index digest in
each image job's `env`, the same two values in both jobs:

```text
SYFT_PIN:  ghcr.io/anchore/syft:v1.57.2@sha256:e97e20b6e6d1699c60296b66ab337941724f9bd06ac279d893eda89601fc4b2a
GRYPE_PIN: ghcr.io/anchore/grype:v0.122.1@sha256:661583704a253c0448ed63998b5ea2cd9d5a76ee71eedc4aed439b8ce3e93a1c
```

Each digest was read on 2026-11-26 from an anonymous manifest `HEAD` on
`ghcr.io`, as the index digest of the newest release tag listed there
that day. **Their cosign signatures were not verified.** This sandbox
has no `cosign`, and its proxy refuses
`pkg-containers.githubusercontent.com` and `grype.anchore.io`, so
nothing could be pulled or measured. A
person verifies both on a workstation before merge, against the
keyless identity Anchore documents for its release workflow (expected
to be an issuer of `https://token.actions.githubusercontent.com` and an
identity under `https://github.com/anchore/`; *inference, not checked*),
and records the date here (`TODO.md`, "Open in PT-6b").

No action, downloaded binary or cache is used. Refreshing a scanner is
a reviewed pull request that changes both jobs' pin at once.

## Decision 2 — Steps in the image jobs, on the image they tested

`web-image` and `worker-image` each end with three steps: "Write the
image's SBOM", "Fetch the vulnerability database" and "Scan the SBOM".
They come after every functional step; in `web-image` only "Stop the
server", which runs whatever happened, follows them. Syft reads the
very image the job built and tested, saved with `docker image save`, a
command the guard allows in the image jobs alone. There is no ninth
job, so a pull request still shows 8 checks.

## Decision 3 — Every scanner run is confined

- Every run: `--rm --read-only --cap-drop ALL --security-opt
  no-new-privileges`, as the runner's own user and group, with no
  Docker socket, no `--entrypoint`, no `--env-file` and no platform.
- Every run has `--network none`, except the one `grype db update`,
  which mounts only Grype's own folder.
- Every run writes only to its own `/work`, with `TMPDIR` and
  `XDG_CACHE_HOME` set to it, and to the SBOM folder in Syft's case.
  Its other mounts are read-only: the saved image for Syft; the SBOM
  and the accept list for the scan.
- Grype's database lives inside Grype's `/work`, mounted read-write in
  all three Grype runs. Whether Grype accepts a read-only database,
  and whether it renames its download across mounts, could not be
  measured here; one writable mount avoids both questions.
- The outbound hosts are `ghcr.io` and its blob host for the two
  pulls, and `grype.anchore.io` for the database. Whether the database
  file comes from a further CDN host is *not verified*.
- The job holds no secret and needs no account; each setting is given
  by `-e` from the guard's list, since a step-level `env:` is refused.

## Decision 4 — The SBOM: Syft JSON scanned, CycloneDX 1.6 checked

Grype scans Syft's own JSON, which carries more than CycloneDX does, so
no Debian source-package match is lost on the way (*inference*). Syft
also writes CycloneDX JSON 1.6, the format a deployment would keep; the
job checks its `specVersion` and prints its checksum and the package
count. Neither file survives the job. Keeping an SBOM with each pushed
image belongs to part 2, with Artifact Registry.

## Decision 5 — The gate: a fixable critical finding

- The first Grype run lists every match at every severity, the
  suppressed ones included, fixable or not. Any error in it fails the
  step.
- The second run is `--only-fixed --fail-on critical`. Grype's exit
  code 2 is a finding: the job fails and says how to fix or accept it.
  Any other non-zero code is Grype's own failure and is printed as not
  a finding.
- Grype's description of its `fail-on` setting says the code is 1
  (`cmd/grype/cli/options/grype.go`, line 199). The code at the pinned
  tag returns 2 (`cmd/grype/cli/cli.go`, lines 83 to 93, which map the
  threshold error to 2 and every other error to 1); the gate follows
  the code, not that text.
- Failing on `high` takes a later reviewed pull request, once the
  first run's baseline is known and `postcss` 8.4.31, which `next`
  pins, is settled (`TODO.md`). Whether the web image carries
  `postcss` at all depends on Next.js's output tracing, which was not
  checked (*inference*).

## Decision 6 — Accepted findings

`.github/scan/grype.yaml` holds each accepted finding by its id (CVE or
GHSA), its package's name, version and type (`deb`, `npm` or
`binary`), and a reason that names its `TODO.md` item; nothing else.
The guard refuses any other line, so no `fix-state`, `only-fixed`,
severity or database override can hide there; requires each id in
`TODO.md`; and requires each `npm` entry's version in the lockfile, so
a bump cannot leave a stale entry behind.

The one exception is the base image's own npm and corepack, which the
lockfile never holds; in `worker-image`, which copies no app
`node_modules`, every `npm` finding is one of them. Such an entry
also names its `package.location`, under
`/usr/local/lib/node_modules/`, the Node.js image's global folder
(*inference, not measured here*). No app package lives there, since the
apps are copied under `/app`, so the entry cannot hide an app
package's finding, and the guard allows a location on an `npm` entry
alone. Its version still pins it: a digest refresh that moves npm
leaves it matching nothing, and the TODO item is re-reviewed then.

There is no expiry date:
Grype's ignore rules have none, and the guard reads no clock. Renewal
is a person re-reviewing the TODO item. `.github` is in both ignore
files, so the list never enters a build context.

Who may accept a critical finding is **not decided**; it is a question
for the product owner and the CTO (`TODO.md`, "Open in PT-6b").

## Decision 7 — When the database turns CI red

- A red scan is fixed forward by a small pull request that fixes the
  finding or accepts it under Decision 6. A finding in the base image's
  own npm or corepack is fixed by refreshing the base digest, or
  accepted by its location (Decision 6). Never by `continue-on-error`
  (the guard refuses it), a lower level, an `if:` or re-running until
  green.
- Re-running is right only when "Fetch the vulnerability database"
  itself failed.
- A database older than Grype's default age limit (120 hours), or
  `grype.anchore.io` down, keeps CI red until it recovers or a reviewed
  ADR changes this policy. The guard bans the settings that would turn
  the age or hash check off.
- No timed run exists, so a new advisory is first seen at the next
  push to `main` or pull request.

## Decision 8 — Amendments to ADR-0175

- **Decision 8** ("No scanner in part 1") is superseded. Its reason,
  "a binary and a database that changes daily", is answered thus: each
  scanner is pinned by digest (its signature still to be verified,
  Decision 1); the database is fetched by an isolated run, and `db
  status` prints its state in every log (its build time and checksum,
  *expected*); its daily change is handled by Decision 7. The
  inventory step stays.
- **Decision 2** ("No bot, schedule or step in CI looks for a newer
  digest") now has a signal: a fixable finding in the base layer fails
  the scan, and that is what tells a person to refresh the digest.
  Still no bot, and no step looks for a newer digest. Who refreshes it
  is still not decided (`TODO.md`, "Open in RD-10").

## What was measured

The first CI run, on 2026-11-26 (run 45768707896, head `5117e63`),
with the database of schema v6.1.10 built 2026-11-25 at 06:22Z:

| | `web-image` | `worker-image` |
| --- | --- | --- |
| Packages in the SBOM | 422 | 485 |
| Report rows | 240 | 2,273 |
| Critical, high, medium | 0, 93, 81 | 29, 721, 1,250 |
| Low, negligible, unknown | 11, 49, 6 | 86, 164, 23 |
| Rows with a fixed version | 31 | 24 |
| Rows Debian marks "won't fix" | 119 | 2,038 |
| Gate rows: high, medium, low, unknown | 12, 17, 1, 1 | 10, 12, 1, 1 |
| SBOM, database, scan steps | 10 s, 65 s, 6 s | 12 s, 48 s, 8 s |

- The gate passed in both jobs, with no fixable critical finding;
  nothing was suppressed (`ignore: []`).
- Every run worked under `--user` and `--read-only` with only `/work`
  writable. Debian rows carry CVE ids, npm rows GHSA ids.
- The fixable rows of both images: `brace-expansion`, `glob`,
  `ip-address`, `minimatch`, `pacote`, `picomatch`,
  `postcss-selector-parser`, `sigstore` and `@sigstore/core`, which
  are npm's own dependencies (*inference* from the names; the table
  prints no location), and Debian's `libzstd1` 1.5.7+dfsg-1, fixed in
  1.5.7+dfsg-1+deb13u1 (CVE-2026-124851, severity unknown).
- The web image also lists `postcss` 8.4.31 (two high, two medium) and
  `next` 15.5.28 (three medium, fixed in 15.5.29), both already in
  `TODO.md`. A gate at `high` would fail on `postcss` today.
- The worker image's 29 critical rows are all Debian packages marked
  "won't fix", so the gate, which counts only fixable findings, does
  not see them: CVE-2026-135736, CVE-2026-135743 and CVE-2026-75143 on
  each of FFmpeg's nine packages (27 rows), CVE-2026-52490 on `libtiff6`
  and CVE-2026-6653 on `libxml2`.
- After the SBOM step the runner's disk was 42% used in `web-image` and
  40% in `worker-image`, with 84 GB and 87 GB free. The database step
  is the slow one, well inside its 8 minutes.

Confirmed from the source at the pinned tags (Syft v1.57.2, Grype
v0.122.1): `cyclonedx-json@1.6` is accepted; `--show-suppressed`
exists; the ignore keys `reason`, `type` and `location` exist; `db
status` fails on a missing database or one older than the age limit;
Grype gives its own errors code 1 and a finding at the `--fail-on`
level code 2; the default database download limit is 300 seconds, so
the step allows 8 minutes.

Not measured: whether Syft catalogues the `node` binary (no binary row
has a finding); the path where Syft finds the base image's npm; and the
database's size.

## Considered and not done

- **Trivy.** One image instead of two, and a second registry for its
  database. Against it: telemetry and a version check to switch off; a
  YAML ignore format marked experimental; and the March 2026 compromise
  (GHSA-69fq-xp46-6x23, CVE-2026-33634, Aqua Security's advisory on
  `aquasecurity/trivy`), in which only images referenced by digest were
  unaffected. The id comes from the CTO's PT-6b critique and was not
  checked again here.
- **`scan-action` or `trivy-action`.** It would be the image jobs' first
  third-party action, pinned by tag like the others, and
  `trivy-action`'s tags were replaced in that compromise.
- **A ninth job.** It would rebuild or transfer each image, and add a
  check.
- **Uploading the SBOM.** Artifact storage on every commit, and an
  amendment to ADR-0175 Decision 1.
- **Failing on `high` now.** `postcss` 8.4.31 would fail every run
  until `next` drops its pin; the first run lists it as two high
  findings in the web image.
- **Scanning the lockfile.** `zod` is bundled into Next.js's server
  chunks, so an image scan cannot see it. That is a later milestone,
  after `zod` 4.

## Consequences

- Each image job takes about 70 to 80 seconds longer, most of it the
  database download (first run).
- CI can turn red with no code change: database drift, a database
  older than 120 hours, a Debian security fix on the frozen base, a
  Node.js or npm release.
- `grype.anchore.io` is the one database source, with no fallback.
- Two more pins to refresh, each in both jobs.
- Bundled dependencies, `zod` among them, are invisible to the scan.
- Who may accept a critical finding is not defined.
