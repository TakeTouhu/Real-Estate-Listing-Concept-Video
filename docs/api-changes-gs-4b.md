# API Changes — GS-4b

A generation starts in one commit (ADR-0087). **Migration 32; no route and no
page.** Nothing outside tests constructs the new repository until the start
service (GS-4c) and its route (GS-10).

## HTTP

No change.

## Internal API

### Added: `@app/domain` orchestration start

- `qualityTierForResolution(resolution)`: `720p` is `NORMAL` and `1080p` is
  `HIGH_QUALITY` (ADR-0052 Decision 6).
- `GenerationStartRepository.start(record): Promise<GenerationStartOutcome>`, with the
  types `GenerationStartRecord`, `GenerationStartScene`,
  `GenerationStartSummary`, `GenerationStartAudit` and
  `GenerationStartOutcome`.

`GenerationStartRecord` carries the organization, project, start key, the ids
of the job, reservation, scenes and first requests, the requesting user, the
confirmed quality, the disclosure mode, `startedAt` from the server clock, the
storyboard the service judged current (its fingerprint and its scene ids in
position order), the transition context, and an `audit` builder called with
what the commit wrote.

| Outcome | Meaning | Written |
| --- | --- | --- |
| `STARTED` | the job (`RESERVED`), its reservation and allocations, its scenes and first requests (`PENDING`), as committed | everything, with events and the audit entry |
| `EXISTING` | a start with this key already started this job | nothing |
| `PROJECT_NOT_FOUND` | no such project in this organization | nothing |
| `STORYBOARD_CHANGED` | the project no longer holds exactly that composition, or none is ready | nothing |
| `QUALITY_CHANGED` | the project's resolution no longer gives the confirmed quality | nothing |
| `DURATION_NOT_SUPPORTED` | the storyboard is longer than a generation may be | nothing |
| `DISCLOSURE_MODE_NOT_SUPPORTED` | a mode a job cannot carry | nothing |
| `NO_ENTITLEMENT_PERIOD` | no Unit period covers `startedAt` | nothing |
| `INSUFFICIENT_ENTITLEMENT` | the eligible Units are short, with `eligibleUnits` | nothing (the job rolls back) |

A start key that is not a string of 1 to 200 characters is refused with a
`VALIDATION_FAILED` error before anything is read. An `audit` builder that
throws, or an entry naming another organization than the start's
(`INTERNAL_ERROR`), rolls the whole start back and the error propagates.

The start takes Transaction B's two advisory locks, the reservation-admission
lock for its job and the cost-admission lock for its period, before it locks
the project row, so the cost-admission lock stays the outermost lock
(ADR-0087 Decision 3).

### Added: `@app/database`

- `createGenerationStartRepository(prisma)`, exported from the package root.
- `GenerationJob.idempotencyKey` (`String?`), unique with `videoProjectId`.

### Changed: `@app/database`, internal

Transaction B's body moved, unchanged, from `reserve()` into the module-private
`reserveJobWithin`, which `reserve()` runs in a commit of its own and the start
runs inside its commit. It is not exported, and a static test keeps every
mention of it in `orchestration-repositories.ts`. `reserve()` answers exactly as
before.
