# ADR-0107 — The development pipeline's steps after the copy

Status: Accepted (GS-9b-2, 2026-10-30). The third milestone of row GS-9 of
the generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`: "the pipeline command",
run only when a person or a test starts it, only with the test provider, never
in production). Completes ADR-0106, whose assembly it extends. Builds on:
ADR-0044 (media validation), ADR-0072 (the media suites), ADR-0075 and
ADR-0076 (the composer's two encodes and the Clean Master store), ADR-0080 and
ADR-0081 (the final validation) and ADR-0084 (Transaction L).

## Context

ADR-0106 built every step from a waiting job to a clip copied into the shared
folder. The steps after the copy also exist only as runners that nothing
builds outside tests:

- media validation of each copied clip;
- the resolution of an unusable clip: one automatic retry, then the job fails
  and its Unit is released;
- scene delivery (Transaction F);
- the composition plan (Transaction I);
- the composition (Transaction J), which encodes the Clean Master and the
  video with its disclosure;
- the final validation, which publishes through Transaction G and consumes
  the Unit.

The pieces they need on the machine all exist: `S3ManagedOutputMediaValidator`,
`FfprobeMediaProbe`, the FFmpeg composer, the composition's reader and
publisher, the Clean Master store and its inspector. One was not exported: the
owner-only temporary file factory the composition's reader and the Clean Master
store require, which media validation already uses by default.

## Decision 1 — The assembly builds the six remaining steps, and runs none

`assembleDevelopmentPipeline` now also returns:

| Member | Runner | What it is given |
| --- | --- | --- |
| `mediaValidation` | `MediaValidationLifecycleRunner` | its repository, the validator of Decision 2, the system clock, `mvlease_` lease tokens |
| `mediaFailureResolution` | `MediaFailureResolutionRunner` | its repository, the recovery repository, the recovery planner over the route kit's models and prices with the test route's rate (ADR-0106 Decision 5), the system clock, `gatt_` / `gpsn_` ids and `mrlease_` lease tokens |
| `sceneDelivery` | `ValidatedSceneDeliveryRunner` (F) | its repository |
| `compositionPlan` | `CompositionPlanRunner` (I) | its repository, `gdv_` version ids |
| `composition` | `DeliverableCompositionRunner` (J) | its repository, the reader, composer, publisher, Clean Master store and inspector of Decision 2, the system clock |
| `deliverableValidation` | `DeliverableValidationRunner` (G) | its repository, the validator of Decision 2, the system clock, `dvlease_` lease tokens |

Each step that records a transition gets a worker's context per transition,
as in ADR-0106 Decision 6, with its step's label. Media validation records no
transition and takes no context. The final validation takes its context per
pass, as its `runOnce(limit, context)` always has; the command will pass
`developmentPipelineContext("deliverable_validation")`.

Leases and retry delays are each runner's own defaults: they are recovery
timing after a crash, not product rules, and the command runs one pass at a
time.

## Decision 2 — The machine's FFmpeg and ffprobe, over the shared folder

- One process runner (`createDefaultProcessRunner`, no shell) serves the clip
  maker, the probes and the composer.
- One `S3ManagedOutputMediaValidator` over the shared folder's S3-shaped client
  and an `FfprobeMediaProbe` validates both a clip and a composed video, at
  its 512 MiB ceiling.
- The composition's reader, publisher and Clean Master store use the shared
  folder's client and the owner-only temporary file factory
  (`nodeManagedOutputTempFileFactory`), now exported from `@app/storage`.
- The composer reads the repository's own `assets/disclosure/`, resolved from
  the assembly's module (`DEVELOPMENT_DISCLOSURE_LAYER_DIRECTORY`). The
  command runs from the repository, so its copy is this one, and the composer
  refuses an image whose hash is not the committed one (ADR-0075).

The Clean Master is stored at its internal key, which no signed URL reaches
(ADR-0074), in the same folder.

## Decision 3 — The database suite runs FFmpeg, and its CI job installs it

`tests/integration/development-pipeline.db.test.ts` now runs the whole chain
through the assembly against PostgreSQL:

- **A video is made.** A job started by the real start commit is launched; the
  test provider makes each clip with FFmpeg from the stored JPEG; each clip is
  copied and validated; F delivers both scenes; I plans the video; J composes
  the Clean Master and the video with its disclosure; the final validation
  publishes it. The job is `DELIVERABLE_READY`, the Unit is `CONSUMED`, every
  verdict, receipt and the Unit's use are on the system clock, each receipt
  names the bytes stored, the Clean Master cannot be signed, and the video is a
  1280×720, 10-second file that differs from its Clean Master. That the
  disclosure is drawn on it is the media suite's to prove
  (`composition-runner.media.test.ts`).
- **An unusable clip is retried once, then the Unit comes back.** Each scene's
  clip is not a video, so each is retried once on the test route's prices; the
  retry is the same request, so the test provider answers with the same clip;
  the second failure fails the job and releases the Unit. The other scene's
  work is handed back for five minutes; once L closes that scene, it is
  resolved `OBSOLETE` when next due, and no third attempt is made.

The database job therefore installs FFmpeg as the media job does, and is
pinned to the same Ubuntu 24.04 (it ran on `ubuntu-latest`, which is 24.04
today). Locally, `pnpm test:db` now needs `ffmpeg` and `ffprobe` on the path.
This moves the CI half of GS-9d here; GS-9d keeps the command's own run.

## Decision 4 — Static tests admit the assembly by name

As in ADR-0106 Decision 8, each test that forbids building a step outside its
module admits `apps/worker/src/development-pipeline/assembly.ts` for the
constructors and factories it calls, and for nothing that runs a step:

| Test | Admits |
| --- | --- |
| `media-validation-lifecycle/dormancy` | the runner, the validator, the probe and the process runner |
| `media-failure-resolution/dormancy` | the runner and its repository; no call of either |
| `media-recovery/dormancy` | the planner and the recovery repository; a test bans the assembly calling the planner's `.plan(` or the repository's admission or discovery |
| `scene-delivery/dormancy` | the runner and its repository |
| `deliverable-composition/dormancy` | the runner and the plan repository; no call of either |
| `deliverable-composition-execution/dormancy` | the runner, its repository, the reader, composer, publisher, Clean Master store and inspector |
| `deliverable-validation/dormancy` | the runner and its repository |
| `managed-output/dormancy` | the validator, the probe, the inspector and the process runner; still no child process, `execFile`, `spawn(` or `ffprobe` named in the file |

Every test that bans a call of `.runOnce(` or `.runOne(` outside a runner's
own module still covers the assembly.

## Considered and not done

- **A separate CI job for the suites that need both PostgreSQL and FFmpeg.**
  The same setup twice, for one suite; the database job's one extra step is
  the smaller change.
- **A stand-in process runner, so the suite needs no FFmpeg.** It would have
  to answer ffprobe's JSON and write the composer's files, and would prove
  the stand-in, not the assembly's wiring.
- **A disclosure directory the command names.** The command runs from the
  repository, and the composer already refuses an image that is not the
  committed one.

## Not decided here

- The command (GS-9c): the order of its passes, the cursors, when it stops,
  what it reports and how a person starts it. Two facts from this record bear
  on it. After an initial failure is settled, the other scene's unusable clip
  is owed nothing only once L has closed that scene; its resolution work is
  then resolved `OBSOLETE` on its next due pass, five minutes later
  (`MEDIA_FAILURE_RESOLUTION_RETRY_DELAY_MS`). And the final validation takes
  its context per pass, not per transition.
- Whether the command refuses a database that holds another provider's
  attempts (ADR-0106), or one that is not plainly a development database. The
  steps act on every organization's rows in the database they are given: the
  final validation publishes and consumes Units, F and I advance jobs, and the
  resolution admits retries priced on the test route. Today only the refusal
  in production stands between them and a database that is not a development
  one; the command decides what more it checks before its first pass.

## Consequences

- `assembleDevelopmentPipeline` returns six more runners;
  `DevelopmentPipelineStep` gains `media_validation`,
  `media_failure_resolution`, `scene_delivery`, `composition_plan`,
  `composition` and `deliverable_validation`; the module exports
  `DEVELOPMENT_DISCLOSURE_LAYER_DIRECTORY`.
- `@app/storage` exports `nodeManagedOutputTempFileFactory`.
- The database CI job installs FFmpeg and runs on `ubuntu-24.04`; `pnpm test:db`
  needs FFmpeg locally.
- The static tests of Decision 4.
- No migration, no route, no page, no environment variable.
