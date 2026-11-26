# ADR-0183 — Liveness names the Cloud Run revision

Status: Accepted (PT-7a3, 2026-11-26). A milestone of production
readiness, part 2, approved by the product owner on 2026-11-26 at
04:38Z (`docs/production-readiness-part2-gap-analysis.md`). It changes
no customer surface, charge or business rule: only what the public
liveness probe answers, an engineering and security call recorded
here.

Builds on: ADR-0004 (the public liveness probe takes no token and
exposes no secret), ADR-0152 Decision 4 (liveness loads no database,
storage or provider code), ADR-0175 Decision 3 (no `ARG` in a
Dockerfile).

## Context

`GET /api/health` answers `status`, `service`, `version` and `time`.
In the image `version` is `0.0.0`, so an answer does not say which
build or deploy is serving (`TODO.md`, "Give liveness a build
revision").

Cloud Run's container runtime contract
(`docs.cloud.google.com/run/docs/container-contract`, read on
2026-11-26) sets `K_REVISION`, "The name of the Cloud Run revision
being run", in every container of a service, with the example
`hello-world.1`. Its page on environment variables says "The
environment variables defined in the container runtime contract are
reserved and cannot be set." A job gets `CLOUD_RUN_EXECUTION` instead,
and a worker pool `CLOUD_RUN_REVISION`; neither gets `K_REVISION`
(*inference*: the contract lists other names for them and says nothing
of `K_REVISION` there).

## Decision 1 — The field is `revision`, null when unset

Liveness answers `status`, `service`, `version`, `revision` and `time`,
in that order. `revision` is `K_REVISION` when it has a revision's
shape (Decision 2) and `null` otherwise. Every environment gives the
same keys: locally and in CI the value is `null`.

`buildLiveness` reads the value through a second parameter, beside
`now`, which defaults to reading `process.env.K_REVISION`; the tests
pass their own. `health.ts` still imports only types (ADR-0152
Decision 4), and the env schema (`packages/shared/src/env.ts`) is not
touched: the value is never required, so a start never fails on it.
The route is `force-dynamic` and unchanged, so the value is read on
each request, at run time, never at build. Readiness and `version` do
not change.

## Decision 2 — The shape is a technical bound

The value must match `^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`: a
lower-case letter, then lower-case letters, digits and hyphens, not
ending in a hyphen, 63 characters at most. Anything else, including
upper case, a dot, white space or `<`, answers `null`, so a set
variable can never put arbitrary text into a public answer.

The pattern is *inference*: by default Cloud Run names a revision
`<service>-<5 digits>-<3 letters>`, such as `vtavision-web-00042-abc`,
in DNS-1035 style, and a custom revision suffix gives
`<service>-<suffix>`. The contract's own example `hello-world.1` holds
a dot and answers `null`. If G1 measures a real
revision that does not match, a new ADR widens the pattern. This bounds
what the probe echoes; it is not a rule about names.

## Decision 3 — The public probe may name it

Liveness takes no token, so anyone who can reach it reads the revision.
That shows the service's name and, in the `-0000N-` part, how many
revisions have been deployed. It shows no secret, address, setting or
customer data. Weighed against it:

- **Readiness only.** Readiness is behind `HEALTHCHECK_API_TOKEN`, so
  the name would reach only an operator. Not chosen: the approved PT-7
  item asks for the revision in liveness.

The service name is in Cloud Run's default address (*inference*: the
default `run.app` host carries it). ADR-0174 Decision 7 redirects
that address at the front, though it may still be reached directly,
so the probe may be one of few public places the service name
appears (*inference*). A deploy count tells an outsider no more than
how often the service has been released. The probe still shows no
secret (ADR-0004).

Liveness names the revision. If the disclosure is judged too much, a
new ADR moves the field to readiness; nothing else depends on it.

## Decision 4 — No build commit

`K_REVISION` names a deploy, not a build: two revisions can run one
image, and it says nothing of the commit. Liveness reports no commit.
The simplest route, an `ARG`, is forbidden by ADR-0175 Decision 3 and
`tests/container-images.test.ts`. Today the commit reaches the image
only as the `org.opencontainers.image.revision` label, which the
process cannot read. Another route, such as a setting given at deploy
time or a file in the build context, is not chosen here (*inference*:
ADR-0175 Decision 3 does not forbid either). So the `TODO.md` item
"Give liveness a build revision" stays open, and a new item asks
whether and how liveness should name the commit.

## Consequences

- The liveness answer gains one key. No consumer in the repository
  reads its body: CI's start check and `tests/e2e/security-headers.spec.ts`
  read only the status and headers.
- On Cloud Run an outsider can read the revision's name.
- No CI image step is added: `tests/container-images.test.ts` pins the
  workflow step by step, and `health.test.ts` holds the behavior.
- No route, setting, stored value or migration changes.

## Known gaps

- That Cloud Run sets `K_REVISION`, and that nothing overrides it, is
  read from the contract and the "reserved" sentence. That the value
  has this shape is *inference* (Decision 2), and the contract's own
  example does not have it. G1 is the first measurement of both.
- The worker, if it runs as a Cloud Run job or worker pool, gets
  `CLOUD_RUN_EXECUTION` or `CLOUD_RUN_REVISION`, not `K_REVISION`. It
  has no liveness probe; `TODO.md` records it.

## Considered and not done

- **The plan's wider pattern, `^[a-z0-9][a-z0-9.-]{0,99}$`.** It takes a
  leading digit, a dot and 100 characters, none of which a Cloud Run
  revision has (*inference*).
- **Readiness only.** See Decision 3.
- **The commit through an `ARG`.** See Decision 4.
- **A required env setting.** A missing revision must not stop a start,
  and the schema reads settings, not facts the platform sets.
