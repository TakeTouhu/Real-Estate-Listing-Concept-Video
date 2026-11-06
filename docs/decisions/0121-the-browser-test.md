# ADR-0121 — The browser test

Status: Accepted (GS-13a, 2026-11-06). The first milestone of row GS-13 of the
generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`: "Playwright test of the
whole flow, plus a failure that shows no Unit was consumed; completion
report"). CLAUDE.md names Playwright for the end-to-end layer.

## Context

Every step from sign-up to a downloaded video is built and tested on its own:
unit tests on the logic, route tests on each route, database tests on each
commit, a media suite on FFmpeg, and a database suite that runs the
development pipeline. Nothing yet drives the web app's own pages in a browser,
and the repository has no Playwright.

Clicking the whole way through by hand, on `c4360e4`, showed what such a test
needs:

- **`next dev`, not a production build.** The start of a video and the shared
  folder its photos are kept in exist only outside production (ADR-0085,
  ADR-0090, ADR-0111), and a production build reads its mode as production.
- **A migrated PostgreSQL database**, FFmpeg (the test provider's clips; here,
  photos), and the operator command that gives an organization its plan
  (ADR-0066), since no page does.
- **MFA.** An organization's creator is its `OWNER`, and an `OWNER` reaches the
  organization only once MFA is set up (MFA-3).
- **Hydration.** `next dev` sends a page before its scripts run. A press on a
  client component before then is lost: "Set up MFA" did nothing.
- **A UTF-8 locale.** Chromium saves a file named outside ASCII as `download`
  otherwise (ADR-0118 Decision 2).

## Decision 1 — Playwright drives Chromium against `next dev`

`pnpm test:e2e` runs `playwright test` (`@playwright/test` 1.56.1, pinned to
an exact version), configured in `playwright.config.ts`:

- **The web app** is started by the run itself, `next dev` on port 3210, and
  stopped after it; a server already on that port fails the run rather than
  being reused. It is given the test provider (`VIDEO_PROVIDER=fake`), a
  shared folder under `.e2e/shared` (git-ignored), and fixed throwaway values
  for every secret the schema asks for (`tests/e2e/support/environment.ts`).
  None is a secret and none is production's.
- **The database** is `DATABASE_URL`, which must name a database on this
  machine by the development pipeline's rule (ADR-0108 Decision 6): a local
  host, and no `host` parameter but a socket path, since Prisma connects to
  that parameter before the address's host. Its address is checked and never
  printed. It must be disposable and migrated.
  The run refuses `NODE_ENV=production`.
- **Every command the test runs** (the operator's here; the pipeline's later)
  gets the same environment, so a photo the web app stored is the one the
  command reads.
- **One worker**, one Chromium project. Because `next dev` compiles each page
  and route the first time it is asked for, a navigation is given two
  minutes, an action one, an assertion thirty seconds, a test five minutes and
  the whole run thirty. The first CI run, on an empty `.next`, took 27
  seconds.
- **Nothing logs a signed link.** `next dev` logs each request's address to
  standard output, which is not shown: only its standard error, Next's own
  errors, is. The app's own log goes to standard output too, so it is not
  shown either. A failed test keeps a screenshot; traces, which record every
  request and so the signed links and the session cookie, are off unless
  asked for (`--trace on`) and never kept by CI. A test never opens a signed
  link as a page, so no call log carries one, and keeps only the status of a
  signed link's answer; the pages this test visits show none.

## Decision 2 — Each test starts from its own customer

A test signs a new person up through the sign-up form, at an address no
earlier run used (`example.test`), has them create an organization and set up
MFA with an authenticator app, and has the operator command give the
organization a Premium plan from the first day of this month
(`tests/e2e/support/owner.ts`). So a run never meets an earlier one's rows,
and the database need not be emptied between runs.

The authenticator is the test's own (`tests/e2e/support/totp.ts`): RFC 6238
from Node's HMAC, written apart from the app's, so the app's MFA is checked
against the standard and not against itself. Its unit tests use the RFCs' own
vectors.

## Decision 3 — A client component is used once React has hydrated it

Before the test presses, types into or chooses files for an element of a
client component on a freshly loaded page, it waits until React has attached
that element's handlers (`hydrated`): React keeps them under a
`__reactProps$…` key, and the test reads only that the key is there. A plain
form posts without scripts and is used at once. A fixed wait is never used.

## Decision 4 — CI runs it in an `e2e` job

On Ubuntu 24.04, with a PostgreSQL 16 service container and throwaway
credentials, as the `database` job: FFmpeg, the dependencies, the Prisma
client, the migrations on the empty database, Playwright's Chromium with its
system libraries, then `pnpm test:e2e`. A failed run keeps its report and
results for seven days. Installing FFmpeg and Chromium each fails after thirty
minutes: the package mirror has taken 24 minutes on that step before, and has
hung on it. The job fails after ninety.

## Decision 5 — Chromium runs under a UTF-8 locale

The browser is launched with `LANG` and `LC_ALL` set to `C.UTF-8`, whatever
the machine's own, so a download is saved under the name it was sent
(ADR-0118 Decision 2).

## Decision 6 — The first test: from sign-up to a Property's photos

`tests/e2e/sign-up-and-upload.spec.ts`: a new owner signs up and sets up MFA;
the Units page says the organization has no plan, then, once the operator has
given one, that it is Premium with 40 of 40 Base Units left; the owner creates
a Property, confirming the photos' rights, and uploads three photos FFmpeg
draws from its own test patterns (so no customer photo is used and nothing
binary is committed), each straight to its signed upload link, which answers
`200` to each; each is shown ready, and after a reload the Property lists the
three as `READY` at 1280×720.

## Decision 7 — What stays out

- **The rest of the way to a delivered video** (GS-13b to GS-13d, split in the
  gap analysis): starting a photo's analysis from a page, which no page offers
  yet; the storyboard, the start, the pipeline, the progress, the player and
  the download; a video that is not made, and its Units coming back; and the
  plan's completion report.
- **Firefox and WebKit.** Chromium alone, as ADR-0118 checked.
- **A production build.** Refused by design: the start and the shared folder
  do not exist there.
- **Accessibility and visual checks**, and a check on how long a page takes.
- **No migration**, no route, permission, environment variable of the app's,
  or production code changed.

## Consequences

- One command, `pnpm test:e2e`, proves in a real browser that a new customer
  reaches a Property holding their photos, through the app's own pages, and CI
  proves it on every push.
- A run needs a disposable, migrated local database and FFmpeg, and takes
  about half a minute once the pages have been compiled.
- The web app's pages under `next dev` are now part of what CI checks; a
  production build is still checked by the `verify` job.
