# ADR-0123 — The start refuses scenes no route can make

Status: Accepted (GS-13c-1, 2026-11-09). The first part of GS-13c, the third
milestone of row GS-13 of the generation-to-preview plan the product owner
approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`). The product owner chose
this on 2026-11-08 (typed "開始画面で止めるで確定", answering the decision card
of 2026-11-06 with its recommended option "開始画面で止める"): when a scene
is a length the video cannot be made at, the start page shows no start button,
says which scene to change to what length and to compose again, and reserves
no Unit.

## Context

GS-13's survey (`docs/generation-e2e-gap-analysis.md`, *GS-13*) started a
storyboard of 3-second scenes on the test provider's route, whose model makes
5 to 15 seconds. The start reserved its Unit and created the job; the launch
planner found no route for it (`NO_ROUTE`), and the job waited, its Unit
reserved, with no end. A reservation pending with no end is what ADR-0052
Decision 19 forbids.

Composition takes the shortest and longest scene a member types and divides
the project's length between them (`allocateDurations`). The start (GS-4c,
ADR-0088) checked that a verified route offers the project's quality, but not
that a route can make each scene. The planner (GS-7a, ADR-0094) does check:
one route for the whole job, qualified against the route policy, the priced
generation and audio mode, the model catalog and every scene's settings
(`assertSettingsSupported`: length, native resolution, aspect ratio, camera
motion), and never guessed between two. Two rules about one question would
drift, so the start had to ask the planner's.

The start is built only in development with the test provider (ADR-0111), so
no customer could reach the defect.

## Decision 1 — One rule: the planner's route qualification

The planner's private route qualification moves, unchanged, into
`packages/domain/src/job-launch/route-qualification.ts` as
`qualifyingRoutes(facts, target, routes, models)`, and the planner calls it.
`judgeStartRoute` asks the same question of a storyboard: would the launch
find exactly one route for the job the start would copy from it? It reads the
facts the start commit copies into the job (ADR-0087): the project's quality,
target resolution and aspect ratio, and each scene's length and camera motion,
in order.

The start is handed this as a `StartRouteCheck`, built by `routeCheck(policy,
models)` from the route policy and model catalog the planner is handed. The
web app's start takes it from the test provider's route kit (ADR-0111), whose
policy and catalog the development pipeline's planner is built from too
(`FakeRouteKit.routeCheck`), so the start and the launch cannot disagree about
what a route can make.

The planner's later steps are not repeated at the start: a verified price in
force and an exchange rate are read at launch, at the instant the job is
priced (ADR-0094), and may change between the start and the launch.

## Decision 2 — Asked before anything is reserved, by the offer and the start

Both the offer and the start ask it after the checks they already made of the
storyboard (composed, fresh, the quality offered, every scene usable) and
before the length a video may be, the plan and the Units. The start asks it
again when the form is posted, so a page loaded before a change, or a post
made without the page, is refused before any Unit is reserved or period
opened. A storyboard composed again between the check and the commit is
refused by the commit, which reads the scenes by id (`STORYBOARD_CHANGED`).

## Decision 3 — Scene lengths are named; anything else is not

A scene's length is the one setting a member chooses per scene. So when the
one route the policy sells at the project's quality and resolution refuses
some scenes for their length, the verdict is `SCENE_LENGTHS`: the lengths the
route's model takes and each such scene. The offer
(`SCENE_LENGTHS_NOT_SUPPORTED`) carries them with each scene's id, position
and length, and the start page says:

> Each scene of this video must be 5 to 15 seconds long. These scenes are not:
> Scene 1 · Kitchen · 3 seconds …
> Compose the storyboard again on the project page, with its shortest and
> longest scene within that range, then review the video here. Nothing has
> been reserved.

A model that takes only listed lengths is quoted as listed ("5, 10 or 15
seconds"). A range of seconds names no provider or model.

Any other answer (no route at the quality, two routes that could make it, or a
setting other than length, such as the aspect ratio or a camera motion the
model does not honour) is a project, route table or catalog the member cannot
fix from the storyboard: the offer is `SETTINGS_NOT_SUPPORTED`, and the page
says "This video cannot be made with this project's settings yet." Neither
shows a form.

## Decision 4 — The start route's refusals

A post the start refuses for either reason is sent back to the start page, as
every refusal is (ADR-0111), with a fixed sentence: "Some scenes are a length
this video cannot be made at. Nothing was started. Compose the storyboard
again." or "This video cannot be made with this project's settings yet.
Nothing was started."

## What stays out

- **A limit when composing** (the card's second option): the compose panel
  still takes any shortest and longest scene, and the member learns of a
  length the route cannot make on the start page.
- **The price and the exchange rate** are not checked at the start (Decision
  1). A job the launch refuses for them, or for a route table or catalog
  changed between the start and the launch, still waits with its Units
  (`docs/decisions/TODO.md`, *Bound how long a waiting job refused for
  configuration may hold its Units*).
- **A scene refused for its length and another setting** is named for its
  length first; once composed again, the page says the settings are not
  supported.
- **A production route's start**: none is built (ADR-0054 Decision 7). When
  one is, its route check must be built from the policy and catalog its
  planner is handed, as the test provider's is.
- **No migration**, no route, permission or environment variable.

## Consequences

- A storyboard the launch could never route is no longer started: no Unit is
  reserved, no job created, and the member is told what to change.
- The start and the planner share one route qualification; a change to what a
  route can make changes both.
- The browser test (GS-13c-2) can rely on the start refusing what the test
  provider's route cannot make.
