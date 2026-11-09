# ADR-0125 — The browser test of a video that is not made

Status: Accepted (GS-13d, 2026-11-09). The last milestone of row GS-13 and
of the generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`: "Playwright test of the
whole flow, plus a failure that shows no Unit was consumed; completion
report").

## Context

The second browser test (ADR-0124) takes a new owner from approved photos to a
downloaded video, with one Unit used. ADR-0124 Decision 5 left out a video
that is not made. ADR-0052 Decision 19 asks that a reservation with no
technically valid video delivered be released, never left pending. Each step
of that is built and tested on its own: the test provider refuses a clip it
could not make (ADR-0092), the refused scene settles its job and releases the
Unit (ADR-0083), the job's other scenes close (ADR-0084), the project page
shows the video failed and its Unit back in ADR-0052's words (ADR-0114), and a
new video of the project can start once the Units came back (ADR-0110). The
development pipeline's database suite runs the first three; nothing takes a
customer through them in a browser.

## Decision 1 — A third test, from a start to a video not made

`tests/e2e/a-video-that-is-not-made.spec.ts`, with its own owner and plan
(ADR-0121 Decision 2):

- a Property's three photos are uploaded, analyzed and approved, a project of
  15 seconds at 720p and 16:9 is created, three 5-second scenes composed and
  the video started on the start page, reserving one Normal Unit, as in the
  second test;
- the Units page then shows 39 of 40 Base Units left, since the count leaves
  out a reserved Unit;
- the development pipeline runs once with a test provider that makes no clip
  (Decision 2), and its report shows the video ended as a refused scene ends
  it (ADR-0083, ADR-0084): one scene's failure settled, the job's other two
  scenes closed, and no clip copied;
- the project page shows the video failed, Normal and 15 seconds, with
  ADR-0052's message that the video could not be made and no Unit was used,
  that the 1 Normal Unit reserved for it came back and was not used, and that a
  new video can be started for the project; it shows no player and no download;
- the start page offers the same three scenes again, with its button to start
  and reserve 1 Normal Unit; the test does not press it;
- the Units page shows 40 of 40 left: the Unit came back.

The steps from the review page to the started video move from the second test
into one helper, `startVideo` (`tests/e2e/support/video.ts`), with every check
the second test made between them, so both tests take the same path.

## Decision 2 — The pipeline runs in the test, with no clip made

The test provider makes its clip with FFmpeg from the scene's photo, and
refuses the scene, for good, when no clip is made (ADR-0092). The test makes
that happen with the seam the pipeline's assembly already has for it: the clip
maker it is given, `renderer` (ADR-0106; the database suite's own refusal case
uses it). `tests/e2e/support/clipless-pipeline.ts` runs, in the test's own
process, what the command's entry point runs, in its order: the database
address refused unless it is on this machine, the assembly, the refusal of
attempts that are not the test provider's, the cycles with the command's
default limits (read from the command's own argument parser), and the
command's exit status, with a clip maker that answers that it made nothing. A
run that is not quiet, or in which a step reported a failure, fails the test
with its report. As the command does, it says only the kind of an error that
is not the app's own, whose text may name the database's host or user.

- **Not the command.** The command takes no option to make no clip; adding one
  would change the product's tooling for a test. Nor is a photo broken in the
  shared folder: the source checks would refuse it before the provider was
  asked, which is not the failure this test is about.
- **The kept provider folder** (ADR-0124 Decision 2) is shared with the second
  test. A clip it holds cannot answer this test's request: a request's
  identity includes its photo's asset (ADR-0034), and each test uploads its
  own.
- **What it gives up against the command.** The command's full check of the
  server environment: the test passes the four values the assembly reads,
  fixed in `tests/e2e/support/environment.ts`, and the database address,
  checked as the command checks it. And the second test's three-minute stop
  of the whole process group: a run in the test's process cannot be stopped
  from outside. Its cycles are bounded, and the test's five minutes bound the
  run; a transaction cut short writes nothing. With no clip made it starts no
  FFmpeg for a clip, though a leftover job's composition would.
- **It acts on every job in its database**, as the command does, so an earlier
  run's unfinished job is moved too, with no clip made, and one whose clip
  the provider no longer has fails the run (a mutation run left such a job
  locally); the database must be disposable (ADR-0121 Decision 1). CI's is
  empty.

This is the second path in CI that runs the pipeline's steps, again through a
test (ADR-0108); no workflow, root script or other script names the command,
and the dormancy test is unchanged.

## Decision 3 — What stays out

- **A video cancelled, refused by moderation, or failed after its scenes were
  made** (an invalid composed video, ADR-0081): each ends the same way on the
  page, and each is tested below the browser.
- **Pressing the second start**: the start of a project's next video is
  tested on its own (ADR-0110, ADR-0112).
- **No migration**, no route, permission or environment variable, and no
  production code changed.

## Consequences

- `pnpm test:e2e` proves in a real browser, on every push, that a video that
  is not made uses no Unit, says so in ADR-0052's words, and leaves the
  project free to start again.
- With it, the generation-to-preview plan is complete
  (`docs/generation-e2e-completion.md`, *The plan*).
