# ADR-0122 — Analyze photos from the review page

Status: Accepted (GS-13b, 2026-11-08). The second milestone of row GS-13 of
the generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`). The product owner chose
this on 2026-11-08 (decision card, option "レビュー画面にボタン": a button on
the review page that analyzes the photos not analyzed yet, only when pressed,
with the upload left as it is).

## Context

GS-13's survey (`docs/generation-e2e-gap-analysis.md`, *GS-13*) found that no
page starts a photo's analysis. The review page lists an uploaded photo as
"Not analyzed yet" and offers nothing; only
`POST /api/properties/{p}/assets/{a}/analysis` starts one. Without an analysis
no photo can be approved, so no storyboard or video can be made from the
pages alone.

That route already holds every rule: it needs `asset.upload` in the
organization and the Property in reach, analyzes only a `READY` photo, records
`analysis.requested`, and answers a photo already analyzed with its analysis
rather than a second one (`AnalysisService.analyzeAsset`, ADR-0009). The only
analyzer is the offline, deterministic one, which calls no paid service.

## Decision 1 — A button on the review page, in "Not reviewable yet"

The review page shows "Analyze N photos not analyzed yet" above the photos
not reviewable yet, when at least one photo is `READY` with no analysis and
the member holds `asset.upload`, the permission the route asks for
(`buildReviewBoard`'s `toAnalyze`). Nobody else sees it: a member who cannot
analyze is offered nothing, as a member who cannot decide is offered no
decision. A photo whose analysis failed, or is still `PENDING`, is not
offered again. The same route would try it again, since it reuses such an
analysis rather than adding one, but a `PENDING` analysis may still be running
and two requests for one photo each call the analyzer; offering a retry is
left open (`docs/decisions/TODO.md`, *Retry a failed or abandoned analysis
from a page*).

The button sits in the same place for every viewer and shows nothing while
there is nothing to analyze and nothing to say, so a refusal stays on screen
after the page is read again, even when no photo is left to offer.

## Decision 2 — It asks the existing route for each photo, in turn

One press posts `{ organizationId }` to the existing route for each photo it
names, one after another, as the member (`AnalyzePhotosButton`). No route,
permission or rule is added: who may analyze, which photos may be, the audit
and a second press finding a photo already analyzed all stay with
`AnalysisService`. Nothing is analyzed before the press, and the upload is
unchanged.

While it runs, the button cannot be pressed again and says which photo it is
on ("Analyzing 2 of 3…", announced as a status), counting the photos as they
were when pressed. Then the page is read again from the database
(`router.refresh()`), and the button stays unpressable until that read lands,
so its count is current. Analyzed photos move to "Awaiting decision" and a
failed analysis shows its reason on its photo.

## Decision 3 — A refusal is shown in the page's words

A refusal is shown as `mapAnalysisError` words it, as the decision controls'
are: a `422`'s own message, written for a person, and a fixed sentence for
anything else. A refusal that holds for every photo (`401` signed out, `403`
a role that cannot analyze) stops the run and is shown once; any other is
shown against its photo's name, and the run goes on to the next. Each is an
alert, and none asks the member to try again, since the button does not offer
a photo whose analysis failed.

## Decision 4 — The browser test analyzes from the page

The browser test (ADR-0121) goes on from the uploaded photos to the review
page, presses the button once React has hydrated it, and finds the three
photos awaiting a decision at revision 1, none left to analyze.

## What stays out

- **Retrying a failed or abandoned analysis** from a page (TODO, *Retry a
  failed or abandoned analysis from a page*).
- **What the route already leaves open** stays open, and the button adds no
  new surface to it: `asset.upload` as the permission for analysis is a
  Phase 6C choice still to confirm (TODO, *Confirm the Phase 6C choices
  ADR-0052 did not make*); the analysis routes are not rate-limited (TODO,
  *Add rate limiting as one cross-cutting milestone*) and rely on
  `SameSite=Lax` without an `Origin` check (TODO, *Extend the same-origin
  check to every cookie-based mutation route*); two requests for one photo
  each call the analyzer (TODO, *Deduplicate concurrent analysis work*).
- **Analysis on upload**: the product owner chose the press.
- **The short-scene start** (GS-13's second finding): still with the product
  owner.
- **No migration**, no route, permission or environment variable, and no
  change to the analyzer or the upload.

## Consequences

- A member who may upload can take a Property's photos to "Awaiting decision"
  from the pages alone, in production as in development; the analyzer is the
  free, deterministic one.
- A Property with many photos makes one request per photo per press. Each is
  answered at once by the deterministic analyzer; a paid analyzer would be
  priced per press, as the product owner was told when choosing.
