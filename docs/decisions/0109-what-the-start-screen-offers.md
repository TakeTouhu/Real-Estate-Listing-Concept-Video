# ADR-0109 — What the start screen offers

Status: Accepted (GS-10a, 2026-10-30). The first milestone of row GS-10 of the
generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`: "the start screen and
its route"). Builds on ADR-0088 (the start service), ADR-0087 (the start
commit), ADR-0066 Decision 3 (a Unit period nobody has opened is read as it
would open) and ADR-0053 Decisions 2–3 (eligibility-first funding).

## Context

The start (ADR-0088) takes a confirmation: the quality and the storyboard's
scenes, in order, that the customer saw. Nothing yet says what the screen
shows before that, and the start cannot be asked: it writes. It opens the
Unit period before the commit, and the commit reserves.

So the screen needs a read that writes nothing and answers, for a project
now: whether a start would happen; if so, at what quality, with which scenes,
how long, for how many Units and where they would come from; if not, why, in
terms the customer can act on.

## Decision 1 — The offer is the start service's own read

`GenerationStartService.offer(actorUserId, organizationId, videoProjectId)`.

- **The start's permissions**: `video.generate` and `unit.consume`, checked
  before anything is read. Anyone else is answered `FORBIDDEN`.
- **The start's reach**: a project whose Property is out of the member's
  reach, or deleted, is answered `NOT_FOUND`, as the start answers it; an
  archived Property's project is offered, as the start starts it.
- The authorization, the storyboard read and the reach check are one private
  method that both the offer and the start call, so the two cannot drift.

## Decision 2 — It judges in the start's order, and answers as the start would

| Check, in order | The offer answers | The start answers |
| --- | --- | --- |
| No composed storyboard, or no scene | `NOT_COMPOSED` | `VALIDATION_FAILED` |
| The approved photos changed since it was composed | `STALE` | `VALIDATION_FAILED` |
| No verified route serves the project's quality | `QUALITY_NOT_OFFERED`, with the quality | `QUALITY_NOT_OFFERED` |
| A scene with no compiled prompt, or a camera motion not approved | `RECOMPOSE` | `VALIDATION_FAILED` |
| Longer than a video the product sells | `LENGTH_NOT_SUPPORTED`, with the length | `LENGTH_NOT_SUPPORTED` |
| No plan, or its first period has not started | `NO_PLAN` | `NO_PLAN` |
| Too few Units the video's quality may use | `INSUFFICIENT_UNITS`, with the quality, the Units required and how many could be covered | `INSUFFICIENT_UNITS`, from the commit |
| Otherwise | `READY` | `STARTED` |

Where the start throws `VALIDATION_FAILED`, the offer answers a kind: the
screen explains it and points to the fix (compose again) instead of failing.
The start's checks of the confirmation (`STORYBOARD_CHANGED`,
`QUALITY_CHANGED`) and its replay read have no counterpart: the offer is what
gets confirmed.

`READY` carries the quality, the scenes (id and length, in position order),
the total length, the Units required and the funding (Decision 4). Its
quality and scene ids are exactly the confirmation the start accepts.

## Decision 3 — It reads the period the start would reserve from, and writes nothing

The start opens the renewal period containing now (ADR-0088). The offer reads
the same facts without opening it:

- no subscription, or one whose first period has not started: `NO_PLAN`, as
  the start answers before it looks at the ledger;
- the ledger's period containing now, when it is the subscription's renewal
  period: what remains of it;
- no period: the plan's whole allowance and no add-on block, which is what
  opening it would freeze (ADR-0066 Decision 3, the rule the Units page uses);
- a period there that is not the renewal period, or one whose balance cannot
  be read: `INTERNAL_ERROR`, which the start refuses too.

## Decision 4 — The funding it shows is a forecast

The offer plans with `planUnitAllocation`, the function the commit plans
with: Base Units first (for HQ, within the plan's HQ ceiling), then add-on
blocks of the video's quality only, oldest first. `READY` reports how many of
the required Units would come from Base Units and how many from add-on Units.

It is a forecast. The commit plans again under its locks, and another start,
a purchase or a release in between can change the split or make the Units
short; only the start's allocations are what was reserved. The screen's
wording says "would" (GS-10d).

The offer reveals no more of the organization's Units than the start does:
the Units this video needs, how many the video's quality could cover when
they are short (the start's `eligibleUnits`), and this video's split. Never
the period's balance or its blocks; a holder of `unit.view` reads those on
the Units page.

## Decision 5 — Dormant until the start route

No route, page, migration or environment variable. Nothing outside tests
constructs the service until GS-10c's route, and the static test that pins
this is unchanged.

## Consequences

- The screen can say, before anything is written, whether a start would be
  refused and why, and what the customer would confirm.
- An offer can be `READY` and the start then answer `INSUFFICIENT_UNITS` or
  `STORYBOARD_CHANGED`, when something changed in between: the route shows the
  start's own answer.
- Whether a project with a video in progress or delivered may be started
  again is open with the product owner (asked on 2026-10-30). GS-10b applies
  the answer to the start and to this offer.
