# API Changes — GS-10a

The start offer (ADR-0109). **No migration; no route, no page and no
environment variable.** Nothing outside tests constructs the start service
until GS-10c's route.

## HTTP

No change.

## Internal API

### Added: `@app/domain`, `GenerationStartService.offer`

```ts
offer(actorUserId: string, organizationId: string, videoProjectId: string): Promise<StartOffer>
```

What a start of the project's storyboard would be now, for the start screen.
Reads only: it opens no Unit period and asks nothing of the start commit.
Needs `video.generate` and `unit.consume` (`FORBIDDEN` otherwise); a project
out of reach or of a deleted Property is `NOT_FOUND`; a Unit period that is
not the subscription's renewal period, or that cannot be read, is
`INTERNAL_ERROR`.

### Added: `@app/domain`, `StartOffer`

| Kind | Fields | Meaning |
| --- | --- | --- |
| `READY` | `qualityTier`, `scenes` (`id`, `durationSeconds`, in position order), `durationSeconds`, `requiredUnits`, `funding` (`baseUnits`, `addOnUnits`) | a start would happen; the quality and scene ids are the confirmation the start accepts; the funding is a forecast |
| `NOT_COMPOSED` | — | no composed storyboard, or no scene |
| `STALE` | — | the approved photos changed since it was composed |
| `RECOMPOSE` | — | a scene was composed before generation could use it |
| `QUALITY_NOT_OFFERED` | `qualityTier` | no verified route serves the project's quality |
| `LENGTH_NOT_SUPPORTED` | `durationSeconds` | longer than a video the product sells |
| `NO_PLAN` | — | no plan, or its first period has not started |
| `INSUFFICIENT_UNITS` | `qualityTier`, `requiredUnits`, `eligibleUnits` | the Units the video's quality may use cover only `eligibleUnits` |

### Changed: `@app/domain`, `GenerationStartServiceDeps`

`ledger` is now `Pick<UnitEntitlementRepository, "openPeriod" | "findPeriodAt"
| "balance">`; the database's Unit entitlement repository already has all
three. The start itself is unchanged.

### Changed: `@app/domain/testing`, `InMemoryUnitPurchases`

Adds `balance`, read from its `InMemoryUnitsReader`.
