# API Changes — GS-4c

The start service (ADR-0088). **No migration; no route and no page.** Nothing
outside tests constructs the service until the start route (GS-10).

## HTTP

No change.

## Internal API

### Added: `@app/domain` orchestration start service

`new GenerationStartService(deps).start(actorUserId, input): Promise<StartGenerationOutcome>`

`deps`: `identity` (memberships, clock, ids), `properties` (`findById`),
`storyboard` (`getStoryboard`), `qualities` (`StartQualityOffer`),
`subscriptions` (`findByOrganization`), `ledger` (`openPeriod`) and `starts`
(`GenerationStartRepository`).

`input` (`StartGenerationInput`): the organization, the project, the start key,
and what the start screen showed and the customer confirmed: the quality and
the storyboard's scene ids in position order.

| Outcome | Meaning |
| --- | --- |
| `STARTED` | the job (`RESERVED`), its reservation and allocations |
| `ALREADY_STARTED` | this key already started this job, read before the storyboard is judged |
| `STORYBOARD_CHANGED` | the storyboard is no longer the confirmed scenes in that order |
| `QUALITY_CHANGED` | the project's resolution no longer gives the confirmed quality |
| `QUALITY_NOT_OFFERED` | no verified route serves the project's quality (today, HQ) |
| `LENGTH_NOT_SUPPORTED` | the storyboard is longer than 90 seconds |
| `NO_PLAN` | no subscription, or one that has not started |
| `INSUFFICIENT_UNITS` | the eligible Units are short, with `eligibleUnits` |

Errors (`AppError`):

| Code | When |
| --- | --- |
| `VALIDATION_FAILED` | a start key that is not 1 to 200 characters; no composed storyboard; a stale one; a scene with no compiled prompt or an unapproved camera motion |
| `FORBIDDEN` | a non-member, or a member without `video.generate` or `unit.consume` |
| `NOT_FOUND` | another organization's or a missing project, a Property out of reach, or a deleted Property |
| `INTERNAL_ERROR` | a period the plan did not open overlaps the current one; the commit refuses Mode A or finds no period |

Only `STARTED` writes a job. Every other answer writes nothing a customer can
see or is charged for; opening the current Unit period, idempotent, is the only
write before the commit.

Also added: `StartQualityOffer` and `AUTHORIZED_ROUTE_QUALITY_OFFER` (the
qualities `AUTHORIZED_QUALITY_TIERS` lists), `GENERATION_START_AUDIT_ACTION`
(`generation.started`) and `GENERATION_JOB_AUDIT_RESOURCE_TYPE`
(`generation_job`).

### Changed: `GenerationStartRepository`

- Added `findStarted(organizationId, videoProjectId, idempotencyKey):
  Promise<GenerationJob | null>`: the job a start key started on that project,
  scoped to the organization. A key that is not a string of 1 to 200
  characters is refused (`VALIDATION_FAILED`) before it is read.

### Changed: `@app/database`, internal

`createGenerationStartRepository(prisma)` implements `findStarted`, and its
commit's key-conflict re-read uses it. The start key check is shared by both.
