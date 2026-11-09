# ADR-0123 — The start refuses scenes no route can make

Status: Accepted (GS-13c-1, 2026-11-09). The first part of GS-13c, the third
milestone of row GS-13 of the generation-to-preview plan the product owner
approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`). The product owner chose
this on 2026-11-08 (typed "開始画面で止めるで確定", answering the decision card
of 2026-11-06 with its recommended option "開始画面で止める"): when a scene
is a length the video cannot be made at, the start page shows no start button,
says which scenes and what lengths they must be, and reserves no Unit. The
card also said the member would be told to change the scenes' seconds and
compose again; that is not something composition allows (Context), so the
page says what does change them (Decision 3).

## Context

GS-13's survey (`docs/generation-e2e-gap-analysis.md`, *GS-13*) started a
storyboard of 3-second scenes on the test provider's route, whose model makes
5 to 15 seconds. The start reserved its Unit and created the job; the launch
planner found no route for it (`NO_ROUTE`), and the job waited, its Unit
reserved, with no end. A reservation pending with no end is what ADR-0052
Decision 19 forbids.

Composition shares the project's length between its approved photos as
equally as whole seconds allow (`allocateDurations`); the shortest and longest
scene a member types only bound that split, refusing a project whose length
does not fit them, and never change it. A project's length is fixed when it is
created, and no page withdraws a photo's approval. So a storyboard's scene
lengths change only with a new project of another length, or with more
approved photos. The start (GS-4c,
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

The planner's private route qualification moves into
`packages/domain/src/job-launch/route-qualification.ts` as
`qualifyingRoutes(facts, target, routes, models)`, and the planner calls it.
Its checks are the same; the paid-submission gate's own check now runs before
each scene's rather than after, and both are pure, so it chooses the same
routes.
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

## Decision 3 — Scene lengths are named, with what changes them

A scene's length is the one setting of a storyboard a member can change, if
not on the storyboard itself (Context). So when the one route the policy sells
at the project's quality and resolution refuses some scenes for their length
alone (the same storyboard, with each such scene at a length the route takes,
would pass), the verdict is `SCENE_LENGTHS`: the lengths the route's model
takes and each such scene. The offer (`SCENE_LENGTHS_NOT_SUPPORTED`) carries
them with the storyboard's length, how many scenes share it, and each such
scene's id, position and length, and the start page says:

> Each scene of this video must be 5 to 15 seconds long. These scenes are not:
> Scene 1 · Kitchen · 3 seconds …
> A scene's length is the project's length shared between its approved
> photos: here 9 seconds between 3 photos, so composing the storyboard again
> gives the same lengths. To make this video, create a new project whose
> length, shared equally between the 3 photos, gives each 5 to 15 seconds.
> Nothing has been reserved.

When every scene named is longer than the longest length the route takes, the
page adds "or add and approve more photos, then compose this storyboard
again"; more photos shorten scenes, and nothing on the pages gives fewer. A
model that takes only listed lengths is quoted as listed ("5, 10 or 15
seconds"), and "shared equally" then gives the project lengths that work. A
range of seconds names no provider or model.

Any other answer (no route at the quality, two routes that could make it, or a
setting other than length, such as the aspect ratio or a camera motion the
model does not honour) is a project, route table or catalog the member cannot
fix that way: the offer is `SETTINGS_NOT_SUPPORTED`, and the page says "This
video cannot be made with this project's settings." So is a scene refused for
its length and another setting together, which fixing the length would not
make. Neither shows a form.

## Decision 4 — The start route's refusals

A post the start refuses for either reason is sent back to the start page, as
every refusal is (ADR-0111), with a fixed sentence: "Some scenes are a length
this video cannot be made at. Nothing was started." or "This video cannot be
made with this project's settings. Nothing was started." The start page then
shows the offer, which says what to change.

## What stays out

- **A limit when composing** (the card's second option): the compose panel
  still takes any shortest and longest scene, and the member learns of a
  length the route cannot make on the start page.
- **Changing a project's length, or withdrawing an approval, from the pages**:
  neither exists, so scenes too short are fixed only by a new project
  (`docs/decisions/TODO.md`, *Let a member fix a storyboard whose scenes the
  route cannot make without a new project*).
- **The price and the exchange rate** are not checked at the start (Decision
  1). A job the launch refuses for them, or for a route table or catalog
  changed between the start and the launch, still waits with its Units
  (`docs/decisions/TODO.md`, *Bound how long a waiting job refused for
  configuration may hold its Units*).
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
