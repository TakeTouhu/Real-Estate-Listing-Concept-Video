# ADR-0094 — The concurrent-job limit, and a waiting job's launch plan

Status: Accepted (GS-7a, 2026-10-28). First of four pull requests for row GS-7
of the generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`, row GS-7 and Design 6:
"an organization runs at most 1 / 3 / 5 jobs at once … extra jobs wait with
their Units reserved and start oldest first").
Builds on: ADR-0052 Decision 7 (concurrent customer video Jobs), ADR-0087 and
ADR-0088 (the start leaves the job `RESERVED`), ADR-0089 and ADR-0090 (the route
policy, and the test route), Phase 4C's media-recovery planner (a new attempt is
priced fresh).

## Context

A started job is `RESERVED`: its Units are held, its scenes and their first
requests are `PENDING`, and it has no attempt (ADR-0087 Decision 5). Nothing
launches it. Attempt admission (Transaction C, `admitAttemptWithin`) creates an
attempt and starts its request, but it takes the route, the rendered prompt and
the price from its caller, and it neither starts the scene nor the job
(`docs/decisions/TODO.md`, *Start each scene in the commit that admits its first
attempt*). The plan limits how many jobs an organization runs at once, and no
plan records that limit.

GS-7 is therefore split into four pull requests:

| PR | What |
| --- | --- |
| GS-7a (this) | the limit on each plan, which jobs hold a place under it, and the launch plan: one route for the job, a prompt and a price per scene |
| GS-7b | the launch commit: under one organization-wide lock, a free place, the oldest waiting job, the job and its scenes started and each first attempt admitted, in one commit |
| GS-7c | sending an admitted attempt to the provider and recording the answer, through the paid-submission gate |
| GS-7d | releasing a job that can never launch, and its Units |

## Decision 1 — The limit is a plan fact

`CustomerPlan.concurrentJobs` records ADR-0052 Decision 7: Standard 1, Premium
3, Enterprise 5. It counts customer video Jobs, not the provider requests inside
them, and HQ shares it; a test pins the three numbers. A job beyond it waits, its
Units reserved, and is not refused.

## Decision 2 — A job holds a place from launch until it ends

| Job state | Under the limit |
| --- | --- |
| `RESERVED` | waits for a place |
| `GENERATING`, `SCENES_READY`, `COMPOSITION_PENDING`, `COMPOSING`, `DELIVERABLE_VALIDATING` | holds a place |
| `REVISING` | holds a place |
| `CREATED`, `RESERVING` | neither: not started |
| `DELIVERABLE_READY`, `FAILED_TERMINAL`, `CANCELLED` | neither: ended |

A job keeps its place through composition and the final check, because until a
video is delivered or the job has failed the customer is still waiting for it,
and the plan's limit is about the customer's jobs. `REVISING` holds one too:
revision start passes through it in one commit, so no job rests there today, and
a job that did would be mid-revision. `decideJobLaunchCapacity` says whether one
more job may launch, and refuses a limit below one or a count that is not a
whole number as a defect rather than launching on it. A test classifies every
job state, so a state added later must be placed before it can be counted.

## Decision 3 — One route for the whole job, chosen and never guessed

Every scene of a job is sent by the same route, so one video is not stitched
from two models. A route qualifies when:

- the route policy lists it for the job's quality and resolution;
- the model catalog holds its model as selectable, under the route's provider
  and model id;
- the catalog reaches the job's resolution from the route's own native tier;
- the model accepts every scene's length;
- the paid-submission gate's own check (`authorizeRoute`) authorizes it. The
  gate matches a route by model id first, so a second route for the same model
  at another tier is one it cannot authorize, and planning it would admit
  attempts the gate refuses later.

One qualifying route is taken. When several qualify, the model catalog's default
decides; when it is not exactly one of them, nothing is planned
(`AMBIGUOUS_ROUTE`). Which provider to prefer between two authorized routes is a
product decision this planner does not make up. The test route has one route per
quality, so it is never ambiguous.

The plan records how the catalog delivers the target (the native tier, the
normalization, whether the native output meets the target), which admission
binds into the attempt's request identity.

## Decision 4 — Priced at launch, per scene, at one instant

Every scene is priced at the planning instant against the one verified contract
in force for the route, at the rate the FX source gives then, with the job's
risk profile (`NORMAL_AI` or `HIGH_QUALITY_AI`) and the scene's own length, as a
media recovery prices its new attempt. No contract in force, or a length the
contract cannot bill, plans nothing (`NO_CURRENT_PRICING`); two in force for one
route plans nothing (`AMBIGUOUS_CURRENT_PRICING`). The paid-submission gate
re-derives the cost from the same contract before anything is sent.

Which contracts are in force for a route is decided in one place,
`currentlyEligibleContractsForRoute` in the pricing domain, which the
media-recovery planner now uses too in place of its private copy.

The rate is read last, only once a route and a price exist, and a source that
answers nothing, answers a rate that is not USD to JPY or throws plans nothing
(`NO_FX_RATE`). Nothing the source said travels further.

## Decision 5 — The provider prompt is rendered at launch, once

Each scene's frozen compiled prompt is rendered by `renderPrompt`, the same
renderer every new attempt uses (ADR-0023), before any catalog is consulted. A
scene with no prompt (`SCENE_PROMPT_MISSING`) or one that does not render
(`SCENE_PROMPT_UNRENDERABLE`) plans nothing for the whole job.

## Decision 6 — The planner decides nothing else, and is dormant

`JobLaunchPlanner.plan` reads catalogs and a rate source and writes nothing. It
does not decide capacity, does not lock, and returns either a plan for every
scene or one fixed code. The launch commit (GS-7b) re-reads the job under its
own locks and admits the plan's attempts or none. Its codes carry no prompt, no
provider text and no identifier.

Some codes can pass (a rate that cannot be read now, a rate card mid-
replacement); others never will (a scene with no prompt). Which of them release
a waiting job's Units is GS-7d's decision.

Nothing outside tests constructs the planner. A static test pins that, and that
it reaches no provider, HTTP client, storage or database.

## Not decided here

- **The launch commit** (GS-7b): the organization-wide serialization point, the
  oldest-first order, where the limit is read from, and the commit that starts
  the job and its scenes and admits each first attempt. The limit is to be read
  from the organization's current subscription, so an upgrade raises it at once
  (ADR-0053 Decision 3B).
- **Revision start under the limit.** Revision start moves a delivered job to
  `GENERATING` in one commit without consulting the limit. Nothing runs it
  today; recorded in `docs/decisions/TODO.md`.
- **A lower execution limit from the Provider Safety Guard** (ADR-0052 Decision
  7, ADR-0054): not built.

## Consequences

- `CustomerPlan` gains `concurrentJobs`. No migration: the plan catalog is code.
- New `@app/domain` module `job-launch`: the limit's rule and the planner.
- `currentlyEligibleContractsForRoute` moves into the pricing domain; the
  media-recovery planner's behaviour is unchanged and its tests pass as they
  were.
- No code path a customer or a worker reaches changes.
