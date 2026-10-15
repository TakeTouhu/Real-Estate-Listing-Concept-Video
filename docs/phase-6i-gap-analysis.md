# Phase 6I gap analysis — Property reach

Status: 6I-1 implemented on branch `claude/project-thread-az06z2`; 6I-2 not
started.
Base: `main @ 5c6a74d` (PR #82, near-duplicate rule removal, merged
2026-10-15; migration 24 is the latest).

Authority: ADR-0052 Decision 10 (*`authorized = tenant boundary AND permission
AND Property-derived scope predicate`*; the `ORGANIZATION`, `GROUP` and `OWN`
predicates; *scope is fixed by role*; *children inherit their Property*; *no
authorship-based row authorization*; *grants never widen scope*), ADR-0010 (a
record outside the caller's reach is not found), ADR-0062 (the responsible
user and group a Property carries).

## Why this package is next

Role templates, individual grants, groups, group permissions and Property
assignment exist (6C to 6H). Every content path still checks only membership
and a permission, so every member reaches every Property of its organization.
Reach is the last part of ADR-0052 Decision 10, and it must exist before the
first member-management screen. The near-duplicate review rule, which grouped
photos across the whole organization, was removed first (ADR-0063).

## Every path, on `5c6a74d`

18 authorization points in four services read or write Property content.
Generation admission has no Property lookup of its own: it reads the
storyboard through `StoryboardService`.

| Service | Path | Permission | How the Property is found | Package |
| --- | --- | --- | --- | --- |
| `PropertyService` | `list` | `property.view` | the organization | 6I-1 |
| | `get` | `property.view` | the Property id | 6I-1 |
| | `update` | `property.edit` | the Property id | 6I-1 |
| | `remove` | `property.delete` | the Property id | 6I-1 |
| `AssetService` | `requestUpload` | `asset.upload` | the Property id | 6I-1 |
| | `completeUpload` | `asset.upload` | the photo's Property | 6I-1 |
| | `list` | `property.view` | the Property id | 6I-1 |
| | `createDownloadUrl` | `property.view` | the photo's Property | 6I-1 |
| | `retryUpload` | `asset.upload` | the photo's Property | 6I-1 |
| | `requestDeletion` | `asset.delete` | the photo's Property | 6I-1 |
| `AnalysisService` | `analyzeAsset` (start, refresh) | `asset.upload` | the photo's Property | 6I-2 |
| | `listForProperty` | `property.view` | the Property id | 6I-2 |
| | `getForAsset` | `property.view` | the photo's Property | 6I-2 |
| | `requireReviewable` (approve, reject, correct) | `analysis.review` | the photo's Property | 6I-2 |
| `StoryboardService` | `createProject` | `video.generate` | the Property id | 6I-2 |
| | `compose` | `video.generate` | the project's Property | 6I-2 |
| | `freshnessOf` (`getStoryboard`, `isFresh`, `assertFresh`) | `video.view` | the project's Property | 6I-2 |
| | `listProjects` | `video.view` | the Property id | 6I-2 |
| `GenerationService` | `startScene` | `video.generate`, `unit.consume` | through `assertFresh` and `getStoryboard` | 6I-2 |

`PropertyService.create` and `assign` need no reach check: a creator always
reaches its new Property (ADR-0062), and only `ORGANIZATION`-scoped roles
reassign.

Every HTTP route and page calls one of these services; none decides
authorization itself.

## Gap

| Concern | Today | Required | Where |
| --- | --- | --- | --- |
| Reach | none | a member's reach from its role's scope; for `GROUP`, its current groups | `reachOf` |
| The predicate | none | `ORGANIZATION`, `GROUP` and `OWN` judged from the Property's organization and assignments, never `createdBy` | `reaches` |
| The Property list | every Property of the organization | the Properties the member reaches, filtered in the query | `PropertyRepository.listReachable` |
| Single rows | found by organization and id | also reached, else answered as not found | `findReachableProperty`, then each path |
| Children | found by organization and id | judged by their own Property | `AssetService.requireReachableAsset` (6I-1); analysis and storyboard (6I-2) |
| Order | permission, then the row and its state | permission, the row, reach, then its state | every path |
| Video projects of a deleted Property | created and listed | refused, as the Property and upload paths already do | `StoryboardService` (6I-2) |

## Choices ADR-0052 does not make (defaults taken, recorded in `TODO.md`)

1. **Out of reach is answered exactly as not found**, never `403`.
2. **An out-of-reach answer is not audited.**
3. **Reach is read at authorization.** In-flight actions and signed URLs
   already issued are not revoked.
4. **A `MANAGER` is judged by its groups only**, even for a Property it is the
   responsible user of.

## Found while mapping

- `StoryboardService.createProject` and `listProjects` check that the Property
  exists but not that it was deleted (6I-2 refuses it).
- Two comments still describe the duplicate-approved invariant ADR-0063 removed
  (`StoryboardService.isFresh`, `apps/web/src/lib/storyboard-route.ts`); 6I-2
  corrects them.

## Milestones

- **6I-1:** the predicate, the Property paths and the photo paths, their tests,
  ADR-0064 and this analysis.
- **6I-2:** analysis, video projects, storyboards and generation admission; the
  deleted-Property refusal; the completion record.
