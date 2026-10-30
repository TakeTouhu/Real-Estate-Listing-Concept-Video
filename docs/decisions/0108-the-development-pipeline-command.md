# ADR-0108 — The development pipeline command

Status: Accepted (GS-9c, 2026-10-30). The last milestone of row GS-9 of the
generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`: "the pipeline command",
run only when a person or a test starts it, only with the test provider, never
in production, with no timer or cron). Runs the steps ADR-0106 and ADR-0107
built, and answers what both left to the command. Builds on ADR-0098 Decision 6
and ADR-0105 (the two windows that move), ADR-0024 (the rows are the queue) and
ADR-0054 Decision 7 (production scheduling stays BLOCKED).

## Context

`assembleDevelopmentPipeline` builds twelve steps on the test provider and the
shared folder, and runs none. Each is a bounded pass over rows the database
already holds: it takes the oldest candidates up to a limit, moves each one
step, and reports what it did. Nothing calls them in order, so a video started
on a development machine never leaves `QUEUED`.

ADR-0107 left the command three facts:

- after an initial failure is settled, the other scene's unusable clip is owed
  nothing only once L has closed that scene, and its resolution work is then
  resolved `OBSOLETE` on its next due pass, five minutes later;
- the final validation takes its context per pass;
- the steps act on every organization's rows in the database they are given,
  and only the refusal in production stood between them and a database that is
  not a development one.

## Decision 1 — A person starts it, once, from the worker

```bash
pnpm --filter @app/worker pipeline --provider-folder <absolute path> \
  [--limit <1 to 25, 10 if omitted>] [--max-cycles <1 to 1000, 50 if omitted>]
```

- `--provider-folder` is the test provider's own folder for its clips
  (ADR-0106). It is required, with no default: the test provider answers a
  later run from the clips it kept there, so a person names one folder and
  keeps it, and the command does not guess one (ADR-0106 left this open).
  `.dev-provider/` in the repository is git-ignored for it.
- `--limit` is how many items each step takes per pass, at most the smallest
  of the steps' own ceilings (composition and the final validation take 25);
  `--max-cycles` bounds one run.
- The entry point (`src/development-pipeline/cli.ts`) parses the arguments,
  loads the server environment, has the assembly build the steps (refused in
  production, given or ambient `NODE_ENV`, unless `VIDEO_PROVIDER=fake`,
  without `SHARED_STORAGE_DIR`, or with a relative folder), checks the
  database (Decision 6), runs, prints, and disconnects.
- Exit status: **0** when the run ended with nothing more to do now and no
  step reported a failure; **1** when it stopped for any other reason or a
  step reported a failure; **2** when it was refused before any step ran
  (arguments, environment, the assembly's refusal or the database's).

It is the worker's `pipeline` script and nothing else: no start-up path,
route, hook, CI step or other script runs it.

## Decision 2 — A cycle runs every step once, in the order work flows

| # | Step | What it moves |
| --- | --- | --- |
| 1 | launch | a waiting job started, its first attempts admitted |
| 2 | submission | each admitted attempt sent to the test provider |
| 3 | provider output | each answer recorded; each finished clip copied into the shared folder |
| 4 | maintenance | an attempt whose answer never came marked uncertain, then exhausted |
| 5 | K | a scene whose attempts all ended without a video settles its job |
| 6 | L | a failed job's other scenes closed |
| 7 | media validation | each copied clip probed: usable, or not |
| 8 | failure resolution | an unusable clip retried once, or its job failed |
| 9 | F | each scene with a usable clip delivered |
| 10 | I | a job whose scenes are all delivered has its video planned |
| 11 | J | the Clean Master and the video with its disclosure composed |
| 12 | G | the video read back and validated, then published and the Unit consumed |

The order is the order work flows, so a step mostly finds the work the one
before it left in the same cycle. K and L come before media validation so a
job that has already failed is settled before its clips are judged; the
resolution comes straight after media validation so a retry is admitted in the
cycle that found the clip unusable.

Each step is a pass of the runner the assembly built, given `--limit`. The
steps that record a transition per pass (provider output, maintenance and the
final validation) are given `developmentPipelineContext` with their own label;
the others take theirs from the assembly per transition (ADR-0106 Decision 6,
ADR-0107 Decision 1). The command builds nothing itself.

## Decision 3 — The two windows that move carry their cursor

The launch and the submission read after a cursor and return `next`, the last
row read when their window was full (ADR-0098 Decision 6, ADR-0105). The
command carries each one from a cycle to the next, so a full window of jobs or
attempts that cannot move yet does not keep the rest from being offered. Every
run starts from the oldest (`null`). The other steps have no window: what they
handle leaves their candidates, and what they cannot handle is reported as a
failure.

## Decision 4 — It stops when a whole cycle changed nothing

A run ends at the first of:

| Stop | When | Exit |
| --- | --- | --- |
| nothing more to do now (`QUIET`) | a whole cycle changed nothing and neither window has more after its cursor | 0, or 1 if any step reported a failure during the run |
| an answer was not recorded (`SUBMISSION_STOPPED`) | the submission reports `stopped` (ADR-0098): an answer from the provider could not be recorded | 1, after the rest of that cycle |
| a step threw (`STEP_THREW`) | any step throws | 1, at once |
| the cycle limit (`CYCLE_LIMIT`) | `--max-cycles` cycles ran with work still moving | 1 |

What each step counts as a change, and as a failure:

| Step | Changed | Failed |
| --- | --- | --- |
| launch | launched + ended | failed |
| submission | sent + ended | failed |
| provider output | `PROVIDER_COMPLETION_APPLIED`, `OUTPUT_VERIFIED` | `OUTPUT_LOCATOR_UNAVAILABLE`, `TRANSFER_RETRYABLE_FAILURE`, `TRANSFER_SOURCE_FAILED`, `STATUS_SOURCE_FAILED`, `STATUS_OBSERVATION_MALFORMED`, `TRANSFER_OUTCOME_MALFORMED`, `PROVIDER_REALITY_CONFLICT`, `ATTEMPT_CONTEXT_INVALID` |
| maintenance | uncertainty entered + exhausted | none |
| K | settled | failed |
| L | closed | failed |
| media validation | `VALID`, `INVALID_MEDIA`, `INTEGRITY_MISMATCH`, and a claim `RELEASED` to be retried later | none |
| failure resolution | claimed | none |
| F | delivered | none |
| I | planned | failed |
| J | claimed | failed |
| G | any outcome that wrote a row | `FAILED` |

A failure never keeps a run going: an item a step cannot handle is offered
again on every pass, so counting it as a change would never end. What is
neither (an attempt still processing, an answer or a verdict already on file,
an item another worker holds or that is not yet due) is work that is not this
pass's to move.

- **A step that throws stops the run at once.** A throw is a fault (the
  database gone, a bug), not an item's outcome; the steps after it would act
  on a state no one has looked at. Only an `AppError`'s code is kept.
- **An unrecorded answer finishes the cycle, then stops.** The submission has
  already stopped sending (ADR-0098); the steps after it in that cycle send
  nothing. Another cycle would send again before anyone has looked.
- **The cycle limit** bounds a step that changes something on every pass
  without converging. One video on the test provider takes one cycle, then a
  quiet one; a job whose clips are unusable takes three, then a quiet one; 50
  leaves room for many jobs queued behind their organizations' limits.

## Decision 5 — It never waits

The command never sleeps, sets a timer or starts itself. Work a step hands
back to be retried later waits for a later run:

- the resolution of the other scene's unusable clip, after its job has failed
  and its Unit has been released, is resolved `OBSOLETE` by a run at least
  five minutes later (`MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS`). It owes no
  money and changes nothing the customer sees: the job is `FAILED_TERMINAL`
  and its Unit `RELEASED` already;
- a clip media validation could not read this time, released to be checked
  again after its delay;
- an attempt left `SUBMITTING`, which the maintenance records as unknown after
  fifteen minutes in development, and one whose answer never comes, which it
  gives up when its one-hour window ends (ADR-0106).

A run that ends `QUIET` therefore means nothing more can move *now*.

## Decision 6 — It refuses a database that holds another provider's attempts

Before its first pass, the command counts the scene attempts addressed to any
provider other than the test provider (`sceneGeneration.providerName` not
`fake`). If there is one, it is refused (`CONFIGURATION_ERROR`, exit 2) and
nothing runs.

The steps act on every organization's rows: the final validation publishes and
consumes Units, F and I advance jobs, and the resolution admits retries. A
database that has ever held an attempt for a real provider is not one the test
provider's pipeline may act on. The check reads one count and writes nothing.
It runs once: nothing the command runs can address another provider, because
the assembly's route kit is the test provider's alone (ADR-0090).

This answers the question ADR-0106 and ADR-0107 left open. A database that is
not a development one but holds no attempt of another provider is not
detected by it; the refusal in production and `SHARED_STORAGE_DIR`, itself
refused in production, still guard that case.

## Decision 7 — It reports counts only

Each cycle prints one line naming what each step changed, and how many items
it could not handle; the run ends with one line saying why it stopped and the
totals:

```text
cycle 1: launch 1, submission 2, provider output 2, clips checked 2, scenes delivered (F) 2,
  videos planned (I) 1, videos composed (J) 1, videos validated (G) 1
cycle 2: nothing changed
nothing more to do now after 2 cycles; in all: launch 1, submission 2, provider output 2, …
```

(Each is one line; the first is wrapped here.)

No id, key, URL, signed address, provider payload or error text is printed:
the database holds the rows a developer may look at, and a thrown error is
reported by its step and its `AppError` code only.

## Decision 8 — Static tests admit the command by name, and the run is tested

Each test that forbids a production call of a step's pass admits exactly
`apps/worker/src/development-pipeline/command.ts`, and only for that call:

| Test | Admits for the command |
| --- | --- |
| `media-validation-lifecycle/dormancy` | `.runOnce(`; `.runOne(` stays banned |
| `media-recovery/dormancy` | `.runOnce(`; recovery admission and discovery stay banned |
| `scene-delivery/dormancy` | `.runOnce(`; Transaction F's calls stay banned |
| `deliverable-composition-execution/dormancy` | `.runOnce(`; J's transactions stay banned |
| `provider-output/dormancy`, `managed-output/dormancy`, `fal/queue-status-dormancy` | `runProviderOutputBatchOnce`; a single attempt's run and building the runner stay banned |

The command names no runner type: it takes its steps' shape from the
assembly's `DevelopmentPipeline`. The development pipeline's own static test
now says:

- the folder holds the assembly, the photo reader, the command and its entry
  point, and nothing else;
- only the command calls a step's pass (eleven `runOnce` and one provider
  output batch), and it constructs no runner, repository or assembly;
- only the entry point reads the command line; it builds the steps, checks the
  database and hands both to the command, and runs no step itself;
- none of the four sets a timer, listens for a process event, reaches a
  network or names a real provider;
- outside the folder, only the worker's `pipeline` script names it, and
  neither the root's scripts nor any CI workflow runs it.

`tests/integration/development-pipeline.db.test.ts` runs the command's loop
against PostgreSQL and FFmpeg, in CI's `database` job (ADR-0107 Decision 3):
a started job becomes a published video and the run stops quiet with exit 0,
then a second run finds nothing in one cycle; a job whose clips are unusable
is retried once, its Unit is released and the run stops quiet, one resolution
still waiting; and the database check refuses once an attempt names another
provider. This is GS-9d: it needs no milestone of its own.

## Considered and not done

- **Running each step until it is empty before the next.** It hides a step
  that never empties and makes one slow step hold every other; one pass per
  step per cycle lets work flow and makes non-convergence a cycle count.
- **Waiting until handed-back work is due.** A command that sleeps is a
  scheduler in all but name, and the approval allows none; a person runs it
  again.
- **Running the steps at once.** One pass at a time keeps each lease and
  retry delay what ADR-0107 Decision 1 says they are: recovery timing after a
  crash.
- **Printing ids.** Counts say whether the pipeline moved; the rows are in the
  developer's database.
- **Checking the database's name or host.** Neither says reliably what a
  database holds; another provider's attempts do.
- **A filter by organization.** Each step's query would change for it, and a
  development database's organizations are all test ones.

## Not decided here

- How a customer starts a video, sees its progress and previews and downloads
  it (GS-10 to GS-12), and the browser test that runs this command (GS-13).
- Any production scheduler or worker loop: BLOCKED (ADR-0054 Decision 7). The
  command is not one and is refused in production.
