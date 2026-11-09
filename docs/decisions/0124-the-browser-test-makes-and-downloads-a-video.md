# ADR-0124 — The browser test makes and downloads a video

Status: Accepted (GS-13c-2, 2026-11-09). The second part of GS-13c, the third
milestone of row GS-13 of the generation-to-preview plan the product owner
approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`: "Playwright test of the
whole flow, plus a failure that shows no Unit was consumed; completion
report"). How the test proves the delivered video plays was decided in the
GS-13 gap analysis on 2026-11-06 (`docs/decisions/TODO.md`, *Decide how GS-13
proves the delivered video plays*).

## Context

The browser test (ADR-0121) takes a new owner from sign-up to a Property's
photos, analyzed from the review page (ADR-0122). Every later step is built
and tested on its own: the review decisions, the project, composition, the
start (now refusing scenes no route can make, ADR-0123), the development
pipeline (ADR-0108), the progress, the player's link (ADR-0115 to ADR-0117)
and the download (ADR-0118 to ADR-0120). Nothing yet takes one customer
through all of them in a browser. The GS-13 survey did so by hand on
`c4360e4`.

## Decision 1 — A second test, from approved photos to a downloaded video

`tests/e2e/make-and-download-a-video.spec.ts`, with its own owner and plan
(ADR-0121 Decision 2):

- the Units page shows 40 of 40 Base Units left;
- a Property is created and its three photos uploaded and analyzed from the
  review page (`tests/e2e/support/property.ts`, the first test's steps
  without its checks of each);
- a person approves each photo with the review page's Approve, one at a
  time, until none awaits a decision and three are decided;
- a video project named `渋谷 Harbour View`, 15 seconds, 16:9, 720p;
- a storyboard composed with the shortest and longest scene at 5 seconds:
  three scenes, matching the photos approved;
- the start page offers Normal, three scenes, 15 seconds, and its button
  reserves one Normal Unit; the project page then says the start was
  confirmed and shows the video queued, none of its three scenes made and one
  Normal Unit reserved;
- the development pipeline runs once and exits 0, nothing more to do now;
- after a reload, the project page shows the video completed, Normal and 15
  seconds, and that it used one Normal Unit;
- the player's link answers a range of its first 1,024 bytes with `206`,
  `video/mp4` and a `Content-Range`;
- the download saves the file as `渋谷 Harbour View.mp4`; FFmpeg reads it as
  H.264 at 1280×720 lasting 15 seconds, and decodes every frame without an
  error;
- the Units page shows 39 of 40 left. The count leaves out a reserved Unit as
  well as a used one, so it shows that the Unit did not come back; the
  project page shows that it was used.

## Decision 2 — The test runs the pipeline, where a person would

The approval allows the development pipeline command to run only when a
person or a test starts it (ADR-0108). The test starts it once, after the
start, as `pnpm --filter @app/worker pipeline`, with the web app's own
database, shared folder and secrets (ADR-0121 Decision 1). The helper,
`tests/e2e/support/pipeline.ts`:

- **keeps the test provider's folder**, at `.e2e/provider` (git-ignored
  with the shared folder), not in the test's own output, which Playwright
  empties at each run: the test provider answers a later run from the clips
  it kept there (ADR-0108 Decision 1).
- **fails the test on a run that does not exit 0**, that is one that stopped,
  saw a failure or was refused (ADR-0108 Decision 1), with its exit status
  and what it printed: counts and why it stopped (Decision 7), and pnpm's own
  lines. The environment is passed to it, never printed.
- **stops a run that outlasts three minutes** with everything it started,
  as one process group, so none of it writes to the database once the test
  has failed. The whole test, one video's run included, takes less than a
  minute and a half here.

This is the first path in CI that runs the command: CI's `e2e` job runs `pnpm
test:e2e`, and the test runs the command. That is the test ADR-0108 allows; no
workflow, root script or other script names the command, and the dormancy
test that forbids those is unchanged. The command acts on every job in its
database, so a run on a database holding an earlier run's unfinished job moves
that job too, and fails if that job fails; this is why the database must be
disposable (ADR-0121 Decision 1). CI's is empty.

## Decision 3 — Playback is proved by the link and by FFmpeg

As decided in the gap analysis: Playwright's Chromium cannot decode H.264
(ADR-0117 Decision 4), so the test asks the player's link for a range, and
has FFmpeg read and decode the file the download saved
(`tests/e2e/support/media.ts`). The player's own message in Chromium, that the
video could not be played, is not asserted either way.

## Decision 4 — Signed links: read from Node, never printed

ADR-0121 Decision 1 said a test never opens a signed link as a page and keeps
only the status of a signed link's answer. This test goes further on both,
and keeps the rule's purpose, that no signed link is printed or recorded:

- **The player's link is asked by Node's `fetch`**, not Playwright's request
  context: Playwright records each of its own calls, with its address, as a
  step of the report CI keeps for a failed run. The test reads the link from
  the player's `src`, which Playwright records without its value. It reads
  the answer's status, `Content-Type`, `Content-Range` and length, never its
  address, and a failure to reach it is reported without the address.
- **The download** is a press of the page's own button, whose answer sends
  the browser to a signed link that becomes a download, never a page shown.
  The test never reads its address. Were that link refused, the page would
  show the refusal at the signed link's address, so no later step may print
  the page's address or assert on it.

## Decision 5 — What stays out

ADR-0121 Decision 7 left the way from analyzed photos to a downloaded video
out of the first test; this test covers it, except:

- **A video that is not made**, its Unit coming back, and the plan's
  completion report: GS-13d.
- **An HQ video, a second video of one project, a video in another aspect
  ratio**, and playing the video in a browser that decodes H.264.
- **No migration**, no route, permission or environment variable, and no
  production code changed.

## Consequences

- `pnpm test:e2e` proves in a real browser that a new customer goes from
  approved photos to a downloaded video, with one Unit used, and CI proves it
  on every push.
- A run takes about a minute and a half on a developer's machine once the
  pages are compiled; the `e2e` job's FFmpeg now also makes the test
  provider's clips and composes the video.
