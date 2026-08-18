# Phase 3B-3b Completion Report — Decision interactions

Merged milestone. Lifecycle facts (PR number, merge commit) are recorded in the
milestone table in `docs/progress.md`; this report is a technical snapshot.
Branch: `claude/real-estate-virtual-tour-phase-3b3b-hga252`
Base: `main` at `c78ecf2588748099012fce6c6a391cd68dc1eaf6` (merged Phase 3B-3a)

Approve and reject from the browser, duplicate-primary selection, per-row
pending and error state, and the jsdom + Testing Library infrastructure. No
domain change, no HTTP contract change, no schema, no migration.

## Pre-implementation gates

| Gate | Result |
| --- | --- |
| Dependencies installable | **yes** — `jsdom@30.0.1`, `@testing-library/react@16.3.2`, `@testing-library/user-event@14.6.1` installed through the proxy |
| DOM infrastructure works | **verified before writing production code** with a throwaway probe: render + click + state update, then deleted |
| Re-cost | **≈525** against the actual 3B-3a files — within the ~500 target, so no split proposal was needed |
| Actual | **516** — 5 lines under the re-cost |

The infrastructure cost 5 lines, not the 25 planned: no setup file is needed
because the `@vitest-environment jsdom` docblock scopes the DOM to `.tsx` tests,
leaving every node-environment suite untouched.

## Milestone size

| File | Changed code lines |
| --- | --- |
| `.../review/review-panel.test.tsx` | 202 |
| `.../review/review-panel.tsx` | 156 |
| `.../review/page.tsx` | 57 (−2) |
| `apps/web/src/lib/decision-errors.ts` | 38 |
| `apps/web/src/app/globals.css` | 31 |
| `apps/web/src/lib/decision-errors.test.ts` | 27 |
| `vitest.config.ts` | 5 (−1) |
| **Total** | **516** — 287 production + 229 tests |

`package.json` and `pnpm-lock.yaml` excluded as machine-generated dependency
records.

## Error presentation — status only, never message parsing

`mapDecisionError(status, message)` implements exactly the approved mapping:

| Input | Message |
| --- | --- |
| `401` | session ended, sign in again |
| `403` | your role cannot approve or reject |
| `404` | no longer available, reload |
| `422` **with** a message | **the API's `error.message`, unchanged** |
| `422` without a message, any other status, non-JSON body, network failure | generic retryable fallback |

No branch inspects message text. Duplicate conflict, already-reviewed, blocking
finding, missing primary, and blank reason are **not** distinguished in the UI —
they share one code today, and telling them apart would turn a display string
into an implicit API contract. A test asserts a `403` carrying
`"internal detail"` renders the permission message and that the detail never
appears. The prerequisite for finer messaging — a machine-readable refusal
reason — is recorded in `docs/decisions/TODO.md`.

## A real defect the production build caught

The panel first imported `mapDecisionError` from `@/lib/review-view`, which
imports `@app/domain`. `next build` failed: that import would have pulled
server-side domain code — and `node:util` behind it — into the **browser
bundle**. Unit tests and typecheck both passed; only the build saw it.

The fix is a standalone `apps/web/src/lib/decision-errors.ts` with **no
imports**, used by the client panel and tested on its own. This is the client/
server boundary `CLAUDE.md` requires, and it now fails loudly if breached again.

## Interaction

- **Two explicit controls**, never a toggle. Approve carries an optional note;
  reject requires a reason and stays disabled while the field is blank or
  whitespace — mirroring the domain rule rather than replacing it.
- **Duplicate clusters**: a radio group names the primary, and approval acts on
  the selected member. The domain requires `primaryAssetId` to equal the asset
  being approved, so one selection drives both and the two cannot disagree. With
  no selection, every approve control is unusable.
- **No `analysisRevision` in any request body.** A test asserts the exact key set
  of an approve request.
- **`router.refresh()` on success only** — the server component re-renders from
  the database rather than merging state client-side, because rejection also
  moves the asset between sections. Asserted called once on success and never on
  failure.
- **Per-row state**: pending shows `Recording…` and disables that row; errors
  render inline on their own row; a failed row stays usable for a retry.

## What the panel never renders

Mounted only where an action exists, so these produce **no controls in the
markup at all**, not disabled ones:

| Case | Result |
| --- | --- |
| Decided revision | no panel — the item has no available action |
| Viewer without `video:review` | no panel |
| Blocking safety finding | no **approve** control; reject remains |
| Duplicate group whose approval is already taken | no panel for the other members |

Those decisions are made server-side in `review-view.ts` (Phase 3B-3a); the
panel renders them and does not re-derive them.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` (node + jsdom) | **pass** — **302/302** in 26 files (17 new) |
| `pnpm build` | **pass** — review route 1.37 kB first-load JS |
| `pnpm test:db` | **pass** — 15/15 against live PostgreSQL 16 |
| Domain / Prisma / HTTP contracts | **zero diff** |

### DOM test coverage (13 cases)

| Area | Coverage |
| --- | --- |
| Approve | posts to the approve route with `{organizationId, primaryAssetId}`; refresh called once |
| Revision | exact key set asserted — **no `analysisRevision`** |
| Reject | disabled until a reason is typed; whitespace stays disabled and sends nothing; posts `{organizationId, reason}` |
| Cluster | two radios; every approve unusable until a primary is chosen; approving sends the selected member as both target and `primaryAssetId`; single photo renders no radios |
| Errors | `422` renders the API message and does not refresh; `401`/`403`/`404`/`500` map by status and hide any carried detail; non-JSON body and network failure fall back generically and leave the row usable |
| Pending | `Recording…` shown, all controls disabled during the request, refresh after it resolves |
| Absent controls | no approve for a blocking item; no controls when neither action is available |

### Runtime smoke

Rendered the page from a running server against live PostgreSQL: a single
awaiting photo mounts one panel with Approve, Reject, and a reason field; adding
a second member to the duplicate group renders the cluster panel with the
"Which photo is the primary?" radio group (2 radios) and per-member controls.
Smoke data deleted afterwards.

## Documentation

| Item | Status |
| --- | --- |
| Completion report | This document |
| Change log | Updated — `CHANGELOG.md` |
| Progress | Updated — `docs/progress.md` |
| UX flow | Updated — `docs/UXFlow.md`, the interactive half |
| Open decisions | Updated — `docs/decisions/TODO.md`, three new entries |
| Architecture diagram | **Unchanged** — no new module or boundary |
| ER diagram | **Unchanged** — no schema change |
| Migration notes | **Unchanged** — no migration |
| API summary | **Unchanged** — no endpoint added or altered |
| Sequence diagram | **Unchanged** — the decide-then-refresh loop adds no new interaction between components |

## Known limitations

- **No end-to-end browser test.** The panel is covered by jsdom tests with a
  stubbed `fetch`, plus a server-render smoke; nothing drives a real browser
  against a real API. Playwright remains unadopted.
- **`422` messages are the domain's wording**, shown verbatim. Reviewer-facing
  copy cannot be tailored per refusal until the API exposes a reason code
  (TODO).
- No rate limiting anywhere — still the cross-cutting item in
  `docs/decisions/TODO.md`.
- Remote publication of all eleven `phase-*-complete` tags remains blocked by
  `HTTP 403` on tag refs. They exist locally only and are **not** claimed to
  exist on GitHub. `phase-3b3-complete` is not created yet — it belongs after
  this milestone merges.
