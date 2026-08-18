# Phase 3B-3a Completion Report — Read-only review surface

Merged milestone. Lifecycle facts (PR number, merge commit) are recorded in the
milestone table in `docs/progress.md`; this report is a technical snapshot.
Branch: `claude/real-estate-virtual-tour-phase-3b3a-hga252`
Base: `main` at `50c2e4df49e921df4430b2becd0741642e625bee` (merged Phase 3B-2)

The first half of the human review UI: a page that shows a property's analyses
grouped for review. It **mutates nothing** — approve/reject controls are Phase
3B-3b — so it exposes no data a member could not already read through the
Phase 3A-3 / 3B-2 API.

## Milestone size — over the target, reported rather than absorbed

| File | Changed code lines |
| --- | --- |
| `apps/web/src/lib/review-view.test.ts` | 252 |
| `.../properties/[propertyId]/review/page.tsx` | 207 |
| `apps/web/src/lib/review-view.ts` | 181 |
| `apps/web/src/app/globals.css` | 37 |
| `.../review/loading.tsx` | 8 |
| `tests/integration/review-duplicate-conflict.db.test.ts` | 6 (−1) |
| `.../properties/[propertyId]/page.tsx` | 3 |
| **Total** | **694** — 436 production + 258 tests |

Estimated ≈455 at plan time. **Delivered 694, about 39% over the ~500 target.**
Nothing in the approved scope was dropped to hide the overrun, and nothing
outside it was added. Where the estimate went wrong:

- **The page: 207 against 110.** Estimated as one list; it is four render paths
  (cluster, awaiting, decided, not-reviewable) over one item renderer, each
  state a separate branch of JSX. JSX costs roughly two lines per rendered fact.
- **The view-model: 181 against 95.** Sixty of those lines are the exported
  types and their doc comments — the contract 3B-3b will build against.
- **The tests: 252 against 185.** Fifty-five lines are the two fixture builders;
  `MediaAsset` and `AssetAnalysis` are wide records, and every field must be
  supplied before a single assertion runs.

If a strict 500 is required, the reviewable subset to defer is the
*Not reviewable yet* section plus thumbnails (≈70 lines of page and ≈45 lines of
tests). That is a scope decision, not a cleanup, so it is left to review rather
than taken unilaterally.

## The two required adjustments

1. **No revision token is sent.** `review.analysisRevision` is displayed, and
   nothing more. No request body carries it, and 3B-3a issues no requests at
   all. Stale views are handled by the existing "already reviewed" `422` when
   3B-3b adds the decision calls — no optimistic concurrency is invented at the
   UI layer. Introducing one would need an explicit API/domain contract.
2. **Error presentation** is a 3B-3b concern; this milestone makes no HTTP
   calls, so no mapping table exists yet. The plan's "render every `422`
   verbatim" is not implemented anywhere.

## What the page shows

| Concern | Behaviour |
| --- | --- |
| Reviewer workflow | Three sections — awaiting decision, decided, not reviewable yet — each with its own empty state |
| Duplicate sets | Members of a multi-member group render as one bordered cluster stating that only one may be approved; a group of one is an ordinary row, matching the domain's primary-choice rule |
| Blocking findings | Blocking flags render in the error style with the sanitized message; a blocked item reports that approval is impossible and rejection is the available action |
| Low confidence | A caution line, never a block |
| Immutable decisions | Decided items render decision, note, reviewer id, timestamp, revision, and the sentence that the decision is final for that revision |
| Revisions | Every analysed row shows its revision number; unanalysed rows show none |
| Authorization | `hasPermission(role, "video:review")` server-side; a `CREATOR` sees a banner and per-item "your role cannot approve or reject photos" |
| Loading | `loading.tsx` renders the page shell while assets, analyses, and thumbnails load |
| Previews | Short-lived signed thumbnail URLs, minted per render, never persisted; assets without a thumbnail render without a preview |
| Not-found | A property outside every organization the viewer belongs to redirects, exactly as the property page does — existence in another tenant is never disclosed |

The `reviewedBy` value renders as the reviewer's **user id**, unchanged from the
API. Expanding it into a name would make the page a directory lookup.

## Where the logic lives

All of it is in `apps/web/src/lib/review-view.ts` — pure functions over domain
records, no React and no fetch — so the rules are tested without a DOM. The page
is rendering only. `packages/domain`, the Prisma schema, migrations, and every
HTTP contract have a **zero diff**.

The view-model decides only what to *show*. Whether a decision is permitted
remains settled by `AnalysisService` and the partial unique index behind it; the
availability flags exist so a reviewer is not offered an action certain to fail.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — root + 11 workspaces, 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **285/285** in 24 files (13 new) |
| `pnpm build` | **pass** — `/properties/[propertyId]/review` present in the route table |
| `pnpm test:db` | **pass** — 15/15 against live PostgreSQL 16 |
| Domain / Prisma / HTTP contracts | **zero diff** |

### Runtime smoke test

The page was exercised against a running server and a live database, not only
through unit tests. Registered a user, created an organization and property,
uploaded photos through the real upload pipeline, and rendered the page:

- three sections render, with empty states where empty;
- two failed analyses appear under *Not reviewable yet* carrying
  `Stored image could not be read for analysis`;
- promoting both rows to `SUCCEEDED` in one duplicate group renders them as a
  cluster ("2 near-duplicate photos"), with room label, revision, warning flag,
  and signed thumbnails;
- approving one member **through the real Phase 3B-2 endpoint** then re-renders
  as `APPROVED · revision 1` with the note, "Final for this revision", and the
  sibling reporting "already approved";
- demoting the membership to `CREATOR` renders the read-only banner and
  per-item "cannot approve or reject photos".

All smoke data was deleted afterwards.

## Two findings from the smoke test

1. **`loading.tsx` turns the unauthenticated redirect into a streamed one.**
   With a loading boundary, Next flushes the shell before the `redirect("/login")`
   resolves, so an unauthenticated request returns `200` with the loading shell
   and a client-side redirect rather than a `307`. **No data is exposed** — the
   body contains only the skeleton — but the redirect is now a visible step. The
   alternative is dropping the loading state or moving auth into middleware;
   both are outside this milestone.
2. **Flat-colour test images collide under the perceptual hash.** Two visually
   different flat images landed in one duplicate group during the smoke. That is
   expected for synthetic images with no structure, not a defect, but it is worth
   knowing before anyone reads pHash behaviour off a synthetic fixture.

## Incidental fix, as requested

`tests/integration/review-duplicate-conflict.db.test.ts` now skips when
`DATABASE_URL` is unset instead of failing inside a hook. **Correction to the
earlier report:** the other two integration suites do not skip cleanly either —
without `DATABASE_URL` all three fail; they merely *report* their tests as
skipped because their setup is in `beforeAll` rather than `beforeEach`. The same
four-line guard would fix them; it is not applied here because it was not in
scope. CI always sets `DATABASE_URL`, so no CI behaviour changes.

## Documentation

| Item | Status |
| --- | --- |
| Completion report | This document |
| Change log | Updated — `CHANGELOG.md` |
| Progress | Updated — `docs/progress.md`, incl. the 3B-2 merge commit and tag record |
| UX flow | Updated — `docs/UXFlow.md`, implemented reviewer surface |
| Architecture diagram | **Unchanged** — no new module or boundary |
| ER diagram | **Unchanged** — no schema change |
| Migration notes | **Unchanged** — no migration |
| API summary / OpenAPI | **Unchanged** — no endpoint added or altered |
| Sequence diagram | **Unchanged** — no new interaction; the page reads through existing service calls |

## Known limitations

- **No decision controls** — Phase 3B-3b. A reviewer can read the queue here but
  must call the API to act on it.
- **No component tests.** The page is verified by the view-model tests, the
  production build, and the runtime smoke; jsdom and Testing Library arrive with
  3B-3b, as approved.
- No rate limiting anywhere — still the cross-cutting item in
  `docs/decisions/TODO.md`.
- Remote publication of all eleven `phase-*-complete` tags remains blocked by
  `HTTP 403` on tag refs. They exist locally only and are **not** claimed to
  exist on GitHub.
