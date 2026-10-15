# Gap analysis — near-duplicate rule removal (before Phase 6I)

Base: `main @ d574506` (PR #81, Phase 6H; post-merge CI run 533 green).
Contract: ADR-0052 Decision 14. Approved for implementation and merge by the
product owner on 2026-10-15.

## What the contract requires

ADR-0052 Decision 14:
- no customer-facing near-duplicate warning;
- no block, and no Unit consequence, because photos look alike;
- perceptual-hash and duplicate data may remain, for internal use only;
- no new near-duplicate UX.

## What is implemented on the base

| Area | Behaviour on `d574506` | Where |
| --- | --- | --- |
| Grouping | `duplicateGroup` computed across the **whole organization** (no Property filter) | `analysis-service.ts` `duplicateCandidates`; `property-repositories.ts` `listWithPerceptualHash` |
| Approval | a multi-member group needs `primaryAssetId`, and it must be the photo approved | `analysis-service.ts` `requirePrimaryChoice` |
| Database | partial unique index: one `APPROVED` analysis per (`organizationId`, `duplicateGroup`) | migration 3, `asset_analyses_org_dupgroup_approved_key` |
| Conflict | the index's violation translated to `DuplicateApprovalConflictError`, then to "Another photo in this duplicate group is already approved" | `analysis-repositories.ts`; `ports.ts`; the in-memory double mirrors it |
| Storyboard | selection refuses two approved analyses in one group | `eligibility.ts`, reached by compose, the storyboard read and `assertFresh` (generation admission) |
| Review page | a multi-member group within the Property shows as one cluster with a primary radio; other members say "already approved" | `review-view.ts`, `review/page.tsx`, `review-panel.tsx` |
| Upload | the completion response lists `duplicateOf`; the panel says "Looks similar to N existing photo(s)" | `complete/route.ts`, `upload-panel.tsx` |
| Analysis API | every analysis response carries `duplicateGroup` | `lib/analysis.ts` `toAnalysisDto` |

**A live defect follows from the first row.** The page clusters within one
Property, but the index spans the organization. A photo whose look-alike is
approved in *another* Property shows Approve enabled; the click fails with
"Another photo in this duplicate group is already approved", and nothing on the
page explains it. Under 6I the same refusal would come from a Property the
reviewer cannot reach.

## The gap

Every row above except the grouping itself is customer-facing near-duplicate
behaviour. Removing it is one change, because three parts depend on each other:
- the index and the storyboard check must go together, or two approved
  look-alikes break composition, the storyboard read and generation admission;
- the page can stop sending a primary only once approval stops requiring one.

## Plan

One pull request, about 300 changed lines of production code:
1. `approve` no longer reads the duplicate group; `ApproveInput.primaryAssetId`
   and `DuplicateApprovalConflictError` go, with the repository's translation
   and the in-memory mirror.
2. Migration 24: `DROP INDEX "asset_analyses_org_dupgroup_approved_key";`.
3. `selectEligibleAnalyses` admits approved look-alikes.
4. The review page loses clusters and the primary radio; the upload panel loses
   the "Looks similar" line; CSS for both goes.
5. The completion response drops `duplicateOf`; analysis responses drop
   `duplicateGroup`; the approve route stops reading `primaryAssetId`.

Kept internally: the perceptual hash, `duplicateGroup` and its non-unique
index, and the duplicate count in the upload audit entry. No data is rewritten.

Choices ADR-0052 does not make, recorded in `TODO.md`: the fields leave the API
responses, not only the screens; `primaryAssetId` is ignored rather than
refused; photos rejected under the old rule are not restored.

## Verification plan

The same checks as Phase 6H: lint, typecheck, unit, database, build, migration
drift and status, and a mutation pass in which each mutant re-introduces one
piece of the removed rule. New tests cover the cross-Property case that fails
today, through the service, the route and live PostgreSQL.
