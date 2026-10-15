# Completion — near-duplicate rule removal

Branch: `claude/project-thread-az06z2`
Base: `d574506` (PR #81 merge commit on `main`)
ADR: `docs/decisions/0063-near-duplicate-rule-removal.md`
Gap analysis: `docs/near-duplicate-removal-gap-analysis.md`

A standalone change between Phase 6H and Phase 6I, implementing ADR-0052
Decision 14. It is not a phase, so it receives no `phase-N-complete` tag.

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `932cbe5` | migration 24; approval without the duplicate group; storyboard selection admitting look-alikes; the review page, upload panel and responses without look-alike data; the unit, route, shape and database tests; the earlier phases' migration pins moved to migration 24 |
| *(this commit)* | ADR-0063, the gap analysis, the documentation updates and this record |

The exact head SHA is reported with the pull request rather than written into a
file that would have to contain its own hash.

## What this change does

- **Approval** no longer reads the photo's duplicate group: no primary choice,
  and approving one look-alike never stops another.
- **Migration 24** drops `asset_analyses_org_dupgroup_approved_key`, the
  one-approved-per-group index. The repository's translation of its violation
  and `DuplicateApprovalConflictError` go with it.
- **Storyboards** admit two approved look-alikes as two scenes.
- **Review page.** No clusters, no primary radio, no "already approved in this
  duplicate set". Every awaiting photo has its own controls.
- **Upload.** No "Looks similar to N existing photo(s)" line; the completion
  response no longer returns `duplicateOf`.
- **Analysis responses** no longer return `duplicateGroup`. An approve request
  that still carries `primaryAssetId` is accepted and the field ignored.

Kept, internally: the perceptual hash, `duplicateGroup` and its non-unique
index, and the duplicate count in the upload audit entry. No row is rewritten.

Behaviour a member can notice: the review page shows look-alikes as ordinary
rows; approving a photo whose look-alike is approved in another Property now
succeeds instead of failing; the upload panel no longer mentions similar photos;
a project can use two look-alike photos.

## Approving a photo whose look-alike is approved in another Property

```mermaid
sequenceDiagram
  autonumber
  participant R as Reviewer
  participant API as approve route
  participant AS as AnalysisService
  participant DB as PostgreSQL

  Note over DB: photo E in Property 2 is APPROVED, in duplicate group G
  R->>API: POST approve (photo A in Property 1, group G)
  API->>AS: approve(org, A, { reason })
  AS->>AS: authorized; analysis SUCCEEDED and UNREVIEWED; no blocking finding
  AS->>DB: UPDATE asset_analyses SET reviewStatus = 'APPROVED' (A)
  Note over DB: before migration 24 the partial unique index refused this write
  DB-->>AS: updated
  AS->>DB: INSERT analysis.approved
  AS-->>API: A approved
  API-->>R: 200, the analysis without duplicateGroup
```

## Verification

Measured on the committed tree `8585412f93f0427710d8345780314d4aae456d17` (commit `932cbe5ab31bf1bd055ad885efd7facf7c741716`),
against a local PostgreSQL 16 configured like CI.

| Check | Result |
| --- | --- |
| `pnpm lint` | clean |
| `pnpm typecheck` (root, all packages, `tests/integration`) | clean |
| `pnpm test` | **5063 / 5063, 164 files (the shape test: 5; the review route suite: 49)** |
| `pnpm test:db` | **1318 / 1318, 45 files (the look-alike approval suite: 3; the review transaction suite: 5)** |
| `pnpm build` | Next.js production build succeeded |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 25 migrations, schema up to date |

Every database test passed, including the provider-output race test that `docs/decisions/TODO.md` has recorded since Phase 6F as able to fail on a legal interleaving; this change touches neither that test nor the code it exercises.

CI on the pull request's exact head is reported with the pull request.

New and changed tests:
- **Service** (`analysis-service.test.ts`): a multi-member group needs no
  primary; both members of one group are approved; a photo whose look-alike is
  approved in another Property is approved.
- **Route** (`review-routes.test.ts`): the same three through the HTTP route; a
  `primaryAssetId` naming another photo is ignored; the response carries no
  `duplicateGroup` although the stored row still has one.
- **Live PostgreSQL** (`review-look-alike-approval.db.test.ts`, which replaces
  `review-duplicate-conflict.db.test.ts`): look-alikes approved in one Property
  and across Properties through the real service and repositories; the unique
  index is absent and the non-unique one present. `review-transaction.db.test.ts`
  now asserts two approved members of one group are stored.
- **Storyboard** (`eligibility.test.ts`, `storyboard-service.test.ts`): two
  approved look-alikes are admitted, composed as two scenes, and fresh.
- **Review page** (`review-view.test.ts`, `review-panel.test.tsx`,
  `review-item-controls.test.tsx`): look-alikes are ordinary awaiting rows that
  keep their approve control; no radio; no `primaryAssetId` in the request.
- **Shape** (`near-duplicate-removal-shape.test.ts`): migration 24 is the
  newest and is exactly the one `DROP INDEX`; the schema keeps `duplicateGroup`
  and its index; no code recognizes the dropped index; no web source reads or
  returns `duplicateGroup`, `duplicateOf` or `primaryAssetId`.

## Mutation ledger

Each mutant re-introduces one piece of the removed rule, or removes one piece
of what is kept, at an anchor that must occur exactly once, and runs against the
suites listed for it. Every mutated file is restored and re-hashed. A SHA-256
manifest of all 767 files in the working tree is compared before and
after the pass. A kill counts only when tests ran and failed; a mutant that
does not parse would count as broken. X01 is a database mutant: it recreates the
dropped index in the local database, runs the database suite, and drops the
index again.

**Authoritative: 18 run, 18 killed, 0 survivors, 0 broken, 0 anchor-missing**, in one uninterrupted pass against the tree
`8585412f93f0427710d8345780314d4aae456d17` (commit `932cbe5ab31bf1bd055ad885efd7facf7c741716`), the reviewed runtime tree. The only
later commit is this one, which changes documentation only. All 767
files were byte-identical after the pass.

| # | Area | Mutation | File | Suites | Killed by |
| --- | --- | --- | --- | --- | --- |
| D01 | approve | one approved photo per duplicate group per organization | `analysis-service.ts` | unit + database | unit: 4 of 638 failed |
| D02 | approve | a multi-member group needs a primary choice | `analysis-service.ts` | unit + database | unit: 6 of 638 failed |
| D03 | approve | one approved photo per group, but only within the Property | `analysis-service.ts` | unit + database | unit: 2 of 638 failed |
| E01 | eligibility | two approved look-alikes make the storyboard input inconsistent | `eligibility.ts` | unit | unit: 2 of 638 failed |
| E02 | eligibility | only the first approved look-alike is admitted | `eligibility.ts` | unit | unit: 2 of 638 failed |
| W01 | review-view | a look-alike's approval stops the others being offered approval | `review-view.ts` | unit | unit: 2 of 638 failed |
| W02 | review-view | look-alikes leave the awaiting list for a cluster | `review-view.ts` | unit | unit: 3 of 638 failed |
| W03 | review-view | the board still carries a clusters list | `review-view.ts` | unit | unit: 1 of 638 failed |
| P01 | panel | approval still sends a primary | `review-panel.tsx` | unit | unit: 5 of 638 failed |
| P02 | panel | approval is held while several photos share the panel | `review-panel.tsx` | unit | unit: 2 of 638 failed |
| R01 | route | the approve route refuses a primary that is not this photo | `approve/route.ts` | unit | unit: 2 of 638 failed |
| R02 | route | the analysis response carries the duplicate group | `analysis.ts` | unit | unit: 2 of 638 failed |
| R03 | route | the upload response says which photos this one resembles | `complete/route.ts` | unit | unit: 1 of 638 failed |
| R04 | upload | the upload panel shows the similar-photos line | `upload-panel.tsx` | unit | unit: 1 of 638 failed |
| S01 | migration | migration 24 drops nothing | migration 24 | unit | unit: 1 of 638 failed |
| S02 | migration | migration 24 also drops the non-unique duplicate-group index | migration 24 | unit | unit: 1 of 638 failed |
| S03 | schema | the non-unique duplicate-group index leaves the schema | `schema.prisma` | unit | unit: 1 of 638 failed |
| X01 | database | the unique index is back in the database | (local database) | database | database: 4 of 8 failed |

"unit" is the analysis and storyboard domain suites, the web review and
property suites, and the review and storyboard route suites. "database" is
`review-look-alike-approval.db.test.ts` and `review-transaction.db.test.ts`.
For D01 to D03 the unit suite failed first, so the database suite did not run
for them; X01 is the mutant that tests the database itself. R03, R04 and S01 to
S03 are killed by the shape test, which reads the source, the migration and the
schema as text.

## Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table (the review row and a new row) |
| Entity-relationship diagram | `docs/er-diagram.md`: the index note and *Near-duplicate rule removal* |
| Critical sequence diagram | this record, *Approving a photo whose look-alike is approved in another Property* |
| OpenAPI / API change summary | `POST /api/assets/{assetId}/complete` no longer returns `duplicateOf`. Every analysis response (analyze, read, refresh, correct, approve, reject one photo; list a Property's analyses) no longer returns `duplicateGroup`. `POST .../analysis/approve` no longer reads `primaryAssetId` and no longer answers 422 for a missing or mismatched primary or for a look-alike already approved. No route added or removed. Internal API: `ApproveInput.primaryAssetId` and `DuplicateApprovalConflictError` removed; `ReviewBoard.clusters` and `DuplicateCluster` removed |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *Near-duplicate rule removal* (migration 24) |
| Completion report | this file |

Also updated: `docs/UXFlow.md` (the review surface as it is now),
`docs/Roadmap.md`, `docs/decisions/TODO.md` (the removal item closed, the three
choices recorded), and *Superseded in part* sections on ADR-0011 and ADR-0012.

## Activation status

No timer, cron or loop is introduced. Paid Provider Activation, production
Provider credentials, production paid AI calls, production scheduler activation
and live Stripe charges all remain **BLOCKED**.

## Carried forward

- **Enforcing reach (6I)**, now without a near-duplicate rule that crosses
  Properties.
- The three choices ADR-0052 does not make, recorded in `TODO.md`.
- Everything Phase 6H carried forward (`docs/phase-6h-completion.md`), unchanged.
