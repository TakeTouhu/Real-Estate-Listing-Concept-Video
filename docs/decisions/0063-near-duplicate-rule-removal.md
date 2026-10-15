# ADR-0063 — Near-duplicate rule removal

Status: Accepted (2026-10-15, before Phase 6I)
Implements: ADR-0052 Decision 14:
- *no customer-facing near-duplicate warning*;
- *no generation block because images look alike*;
- *visual similarity is the customer's responsibility*;
- *perceptual-hash and duplicate data may remain, internally only*.

Supersedes in part: ADR-0011 (its one instance, the partial unique index on
approved duplicate-group members; the rule for hand-written constraints stands)
and ADR-0012 (the storyboard's same-group check). Closes the `TODO.md` item
*Remove the shipped near-duplicate UX that now contradicts ADR-0052 Decision
14*.

## Context

Phase 3B shipped a near-duplicate rule for source-photo review:
- photos whose perceptual hashes are close share a `duplicateGroup`;
- the review page showed a multi-member group as one cluster, and approving a
  member required naming it as the "primary" (`primaryAssetId`);
- a partial unique index (migration 3) allowed at most one `APPROVED` analysis
  per (`organizationId`, `duplicateGroup`);
- storyboard selection refused two approved analyses in one group;
- the upload response listed the existing photos a new one resembled
  (`duplicateOf`), and the upload panel said "Looks similar to N existing
  photo(s)".

ADR-0052 Decision 14 removes all of that from the customer's view. Two facts
made it urgent before 6I (reach by responsible user and group):
- **Grouping ignores Properties.** Groups are computed across the whole
  organization. The review page clustered only within one Property, so a photo
  whose look-alike was approved in *another* Property showed Approve enabled,
  and the click failed with "Another photo in this duplicate group is already
  approved", with nothing on the page to explain it.
- **Under 6I it would leak.** A `MANAGER` or `CREATOR` would be refused because
  of a photo in a Property it cannot reach.

## Decision 1 — Each photo is approved on its own

`AnalysisService.approve` no longer reads the photo's duplicate group. The
primary-choice rule is gone, and so is `ApproveInput.primaryAssetId`. Approval
still refuses a blocking safety finding and an already-reviewed revision.

## Decision 2 — Migration 24 drops the index

`DROP INDEX "asset_analyses_org_dupgroup_approved_key";` and nothing else. The
repository no longer translates that index's violation, and
`DuplicateApprovalConflictError` is removed from the domain.

Kept, for internal use:
- the perceptual hash on `media_assets`;
- `asset_analyses.duplicateGroup`, still computed on analysis;
- its non-unique index (`organizationId`, `duplicateGroup`);
- the duplicate count in the upload audit entry.

## Decision 3 — Storyboard selection admits look-alikes

`selectEligibleAnalyses` admits every succeeded, approved analysis. Two approved
look-alikes become two scenes. This ships with Decision 2: with the index gone
and the check kept, composition, the storyboard read and generation admission
(through `assertFresh`) would refuse any project holding two approved
look-alikes.

## Decision 4 — Nothing customer-facing carries look-alike data

- **Review page.** No clusters, no primary radio, no "already approved in this
  duplicate set" message. Every awaiting photo is its own row with its own
  approve and reject controls.
- **Upload.** The completion response no longer returns `duplicateOf`, and the
  panel no longer shows the "Looks similar" line.
- **Analysis responses** no longer return `duplicateGroup`: analyzing, reading,
  refreshing, correcting, approving and rejecting one photo, and listing a
  Property's analyses.

A `primaryAssetId` in an approve request is **ignored**, not refused, so a
client that still sends one keeps working.

## Decision 5 — No data is rewritten

Migration 24 updates and deletes no row.
- Photos a reviewer rejected under the old rule stay rejected. Those were
  reviewers' decisions; a reviewer who wants one back refreshes its analysis,
  which reopens review.
- An approved analysis on a deleted asset no longer holds its group's slot,
  because there is no slot.

## Consequences

- **Forward-only.** Once two look-alikes are both approved, recreating the
  index fails. Rolling back the application leaves the index dropped: the old
  code then treats a second approval as an ordinary write, and its storyboard
  check would refuse a project with two approved look-alikes. Rolling back is
  therefore not supported once this has shipped.
- `prisma migrate dev` can no longer generate a stray `DROP INDEX` for this
  index (the caveat in `docs/migration-notes.md`, migration 4), because the
  index no longer exists.
- ADR-0011's register of hand-written constraints loses its first entry. Its
  rule for adding one is unchanged.

## Choices ADR-0052 does not make

Recorded in `docs/decisions/TODO.md` for confirmation:
1. `duplicateGroup` and `duplicateOf` leave the API responses, not only the
   screens.
2. `primaryAssetId` is ignored rather than refused.
3. Photos rejected under the old rule are not restored automatically.

## References

- ADR-0052 Decision 14
- ADR-0011, ADR-0012 (superseded in part)
- `docs/migration-notes.md`, *Near-duplicate rule removal* (migration 24)
- `tests/integration/review-look-alike-approval.db.test.ts`
- `packages/domain/src/analysis/near-duplicate-removal-shape.test.ts`
