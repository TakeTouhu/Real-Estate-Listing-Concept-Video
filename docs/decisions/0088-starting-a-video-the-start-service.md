# ADR-0088 — Starting a video: the start service

Status: Accepted (GS-4c, 2026-10-27). Third of three pull requests for GS-4,
the whole-video start step, in the generation-to-preview plan the product owner
approved on 2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`,
Design 2).
Builds on: ADR-0087 (the start commit), ADR-0064 (reach), ADR-0073 (Mode A
frozen on the job), ADR-0067 (opening the Unit period before it is used),
ADR-0012 (freshness is derived), ADR-0052 Decisions 6, 10 and 19.

## Context

GS-4b built the start commit: one transaction that writes the job, its
reservation, its scenes and their first requests, or nothing. It takes a record
someone else must build, and it re-checks only what the project row it locks
can tell it. Nothing decided who may start, whether the storyboard is current,
which quality the start is at, what the customer confirmed, or what opens the
Unit period the reservation draws from.

## Decision 1 — `GenerationStartService.start`, in order

```text
start key of 1 to 200 characters                                 -> VALIDATION_FAILED
video.generate and unit.consume                                  -> FORBIDDEN
the project, its Property reached and not deleted                -> NOT_FOUND
a job this key started on this project?                          -> ALREADY_STARTED
a composed storyboard, still current                             -> VALIDATION_FAILED
the scenes the customer confirmed, in order?                     -> STORYBOARD_CHANGED
the quality the project's resolution gives, the one confirmed?   -> QUALITY_CHANGED
a verified route serves that quality?                            -> QUALITY_NOT_OFFERED
every scene composed for generation (a prompt, an approved motion) -> VALIDATION_FAILED
a length the product sells                                       -> LENGTH_NOT_SUPPORTED
the Unit period containing now, opened if nothing has opened it  -> NO_PLAN
the start commit (ADR-0087)                                      -> STARTED, or Decision 3
```

- **A refusal writes no job, no reservation and no `generation.started`
  entry.** Every check before the period only reads. Opening the period writes
  only the period this month's first Unit action would open, with that period's
  own `entitlement.period_opened` audit entry (idempotent, as a Unit purchase
  opens it, ADR-0067). So a refusal the commit makes after that step leaves the
  period and its entry, which any later Unit action would have written the same
  way, and nothing a customer is charged for.
- **Permission first**, as single-scene admission does: nothing is read for a
  member who may not generate, or may not spend the organization's Units
  (`unit.consume` is its own permission, ADR-0052 Decision 10).
- **Reach.** The storyboard read authorizes `video.view` and answers a project
  out of reach as not found (ADR-0064). The service reads the project's
  Property once more for its status.
- **A deleted Property's project does not start.** Its photos await deletion,
  and the worker treats them as unrecoverable sources (`execution-source.ts`),
  so a start could only reserve Units for a job certain to fail. It is answered
  as not found, as the pages under the Property answer it, even to a replay. An
  archived Property's project starts, as every other path allows. What the
  other paths (reading, composing, single-scene admission) should do with a
  deleted Property's project stays open (`docs/decisions/TODO.md`).
- **The commit checks the Property again, under its lock.** The service's read
  is not enough on its own: a deletion could save between it and the commit.
  So the commit's project read joins the Property and holds both rows
  `FOR SHARE`, and answers `PROPERTY_DELETED` before the replay read. A
  deletion that saves first is seen; one in flight is waited for and then
  refused; one that comes later waits for the start to commit, which is the
  order the two happened in. No cycle: nothing that writes a Property (editing
  it, assigning it, releasing it when a member or group goes) takes the
  project row or the start's advisory locks, and a row inserted with a key to
  the Property takes only `FOR KEY SHARE`, which `FOR SHARE` does not block.
- **The replay is read before the storyboard is judged**, scoped to the
  organization through the project (ADR-0087 Decision 2). A retry still finds
  its job after the customer recomposed, the photos changed, or the project's
  quality would now differ. A replay that arrives while the first start is
  committing is answered by the commit the same way.
- **Freshness is the storyboard read's** (ADR-0012), with the two messages
  `assertFresh` gives: no composed storyboard (no fingerprint, or no scenes),
  and photos changed since it was composed.
- **What the customer confirmed: the quality and the scenes.** The start screen
  (GS-10) sends the quality it showed and the storyboard's scene ids in
  position order. Every composition creates new scene ids, so the ids name the
  composition the screen showed without the fingerprint, which stays internal
  (no DTO carries it). The commit then checks the fingerprint and the same ids
  again under the project lock. The length is the project's, allocated across
  the scenes, so the confirmed quality and composition fix the Units the start
  reserves. Which Units fund it (base before add-on, ADR-0053) is the commit's
  eligibility-first plan; showing it beforehand is GS-10's.
- **Quality offered.** 720p is Normal and 1080p is HQ (ADR-0052 Decision 6), and
  a start at a quality no verified route serves would reserve Units for
  attempts the paid-submission gate refuses. The offer is a port,
  `StartQualityOffer`; `AUTHORIZED_ROUTE_QUALITY_OFFER` is today's, the
  qualities `AUTHORIZED_QUALITY_TIERS` lists: Normal only. So a 1080p project is
  answered `QUALITY_NOT_OFFERED`, as the approved plan's second default says
  until a verified route serves HQ. How the test route offers HQ outside
  production is GS-5's.
- **Scenes composed for generation.** A scene with no compiled prompt (possible
  only before the Phase 3C-3 compiler) or with a camera motion that is not an
  approved value (only before Phase 4C-0b) is refused "compose again", as
  single-scene admission refuses it. Rendering the prompt is left to the launch
  step that admits the attempts (GS-7).
- **Length.** `requiredUnitsFor` on the scenes' total: a project longer than 90
  seconds can be created and composed today, and is answered
  `LENGTH_NOT_SUPPORTED` before the period is opened.
- **The period.** `renewEntitlementPeriod` at the server clock's instant, the
  same instant the record carries as `startedAt`, so the commit reserves from
  the period just opened. No subscription, or one that has not started, is
  `NO_PLAN`. A period the plan did not open overlapping it is the ledger
  disagreeing with the subscription: `INTERNAL_ERROR`, surfaced and never
  started around, as a Unit purchase treats it.

## Decision 2 — The record

- **Ids** from the identity generator: `gjob`, `gres`, and per scene `gscn` for
  its copy and `greq` for its first request.
- **`startedAt`** is the instant the period was opened at.
- **Mode A**, `DEFAULT_DISCLOSURE_MODE`: the only mode today and ADR-0052's
  default where there is a choice (Mode B and C are a later proposal).
- **The transition context**: actor type `USER`, the member, a new correlation
  id per start (`corr`), no cause, no reason, no metadata, event type
  `GENERATION_STARTED`.
- **The audit entry**, written in the commit: `generation.started` on
  `generation_job`, with the project, the reservation, the quality, the length,
  the Units, the disclosure mode, the scene count, and each allocation's source,
  block, quality and quantity. An explicit allowlist: no prompt, provider,
  model or storage key.

## Decision 3 — Outcomes

| Commit | Service |
| --- | --- |
| `STARTED` | `STARTED`: the job, its reservation and allocations |
| `EXISTING` | `ALREADY_STARTED`: the job |
| `STORYBOARD_CHANGED`, `QUALITY_CHANGED` | the same |
| `DURATION_NOT_SUPPORTED` | `LENGTH_NOT_SUPPORTED` |
| `INSUFFICIENT_ENTITLEMENT` | `INSUFFICIENT_UNITS`, with `eligibleUnits` |
| `PROJECT_NOT_FOUND`, `PROPERTY_DELETED` | `NOT_FOUND`, as before the commit |
| `DISCLOSURE_MODE_NOT_SUPPORTED`, `NO_ENTITLEMENT_PERIOD` | `INTERNAL_ERROR`: the service asked for Mode A and opened the period itself |

The outcomes are what the start screen shows; the errors are the ones every
service gives. Refusals are not audited, as single-scene admission's are not:
nothing was started. The returned job is a domain entity; the route projects it
(GS-10).

## Decision 4 — Dormant

Nothing outside tests constructs the service, and a static test pins it; the
start repository is still constructed by nothing either. GS-10 constructs both
behind the start route, which appears only where the pipeline can run (the
approved plan's fifth default).

## Not decided here

- **The start screen** and what it shows before a start, including which Units
  will fund it (GS-10).
- **Admitting the first attempts** (GS-7's launch step), and releasing a job
  that can never launch (`docs/decisions/TODO.md`).
- **A deleted Property's project** on the other paths (`docs/decisions/TODO.md`).

## Consequences

- `GenerationStartRepository` gains `findStarted(organizationId,
  videoProjectId, idempotencyKey)`, the replay read, scoped through the project
  to the organization and refusing a key the column cannot hold, as `start`
  does, or a missing organization or project; the commit's own conflict
  re-read now uses it. The commit gains `PROPERTY_DELETED`, and holds the
  project's Property row `FOR SHARE` with the project's. No migration.
- `@app/domain` exports `GenerationStartService`, `StartGenerationInput`,
  `StartGenerationOutcome`, `StartQualityOffer`,
  `AUTHORIZED_ROUTE_QUALITY_OFFER`, and the audit action and resource type.
- The unit tests prove each refusal, that the members and project each read
  are the ones the start names, that no refusal before the period opens one or
  reaches the commit, and that the period is open when the commit runs; the
  record the commit receives and its audit entry; each commit outcome's
  mapping; and the dormancy. The database tests prove the replay read's
  scoping, the commit's deleted-Property refusal and its wait for a deletion in
  flight, and the service against the real commit
  (`tests/integration/generation-start-service.db.test.ts`): a start, a
  replay, short Units, and a commit refusal that leaves the period and its own
  entry and nothing else.
- No route, no page, and nothing a customer can see changes.
