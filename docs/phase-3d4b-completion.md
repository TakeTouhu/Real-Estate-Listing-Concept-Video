# Phase 3D-4b Completion Report — Review-page correction controls

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3d4b-hga252`
Base: `main` at `cc0d3d525a1647634699d5497a025dbcddb1d4c7` (merged Phase 3D-4a)

The last connection in Phase 3: a reviewer can now see what the analyzer
decided, correct it, save that correction, and then separately approve or
reject — with the two operations kept apart and interlocked so neither can
quietly undo the other.

## Milestone size — 1080, over the ~850 threshold

| File | Changed code lines |
| --- | --- |
| `review/review-item-controls.test.tsx` | 447 |
| `review/correction-panel.tsx` | 214 |
| `review/review-item-controls.tsx` | 90 |
| `lib/review-view.test.ts` | 78 |
| `review/page.tsx` | 55 (−12) |
| `lib/review-view.ts` | 52 |
| `lib/correction-errors.test.ts` | 45 |
| `lib/correction-errors.ts` | 40 |
| `globals.css` | 32 |
| `review/review-panel.tsx` | 27 (−3) |
| **Total** | **1080** — 510 production + 570 tests |

I re-cost to **~865 and reported it before writing code**, judging 1.8% over
your ~850 threshold to be within noise rather than materially above. **The
actual is 1080 — 25% above my own re-cost.** Recording that plainly rather than
letting it pass.

Where it went:

- `correction-panel.tsx` **214 vs ~150** — the explicit `FieldEdit` dirty
  machinery, the discard control, and per-field ARIA labels (needed so a cluster
  with several photos is addressable in tests and by screen readers) cost more
  than a plain form.
- `review-item-controls.test.tsx` **447 vs ~330** — 35 cases. The interlock
  matrix you required is nine tests on its own, and the three-state field
  semantics are nine more, each needing a distinct fixture.

**No required coverage was cut.** The omitted/null semantics, the interlock, and
the authorization-presentation tests are all present in full. If you want the
number down, the honest lever is the discard control (~35 lines including its
test), which you marked optional.

## The interlock — the correction you required

You were right that my original plan encoded a defect. Approving with unsaved
edits on screen would have frozen the revision around the *old* stored
correction and silently discarded what the reviewer could still see.

`ReviewItemControls` is a small client wrapper holding one piece of state — the
set of asset ids with dirty corrections — and nothing else. No context, no
store, no form framework, no domain rule.

```
correction dirty  →  ReviewDecisionPanel gets disabledReason
                  →  Approve and Reject both unavailable
                  →  "Save or discard your correction changes before approving or rejecting."
```

The two operations stay **separate writes**: `CorrectionPanel` never calls
approve or reject, `ReviewDecisionPanel` never submits a correction, and its
request payload is untouched. It gained one presentation-only optional prop,
`disabledReason`; it knows decisions are temporarily held, not why or how
corrections are stored.

A **failed** save keeps the edits dirty, so it does **not** unlock the decision —
tested explicitly, because that is the case where an unlock would be most
dangerous. A successful save calls `router.refresh()` and lets the Server
Component rebuild; nothing unlocks optimistically.

For a duplicate cluster, one decision panel serves several photos, so any dirty
member blocks it — correct, since approving the cluster acts on the member being
edited.

## The three HTTP states, preserved in the UI

Each field tracks `{ touched, value }` explicitly. Dirtiness is never inferred
from whether an input looks empty, because inference cannot separate "never
went near it" from "deliberately cleared it" — and those must send different
things.

| Field state | Request |
| --- | --- |
| untouched | key **omitted** |
| touched, cleared | `"roomType": null` / `"order": null` |
| touched, set | the value |

The room `<select>` carries an explicit **Use analyzer result** option, distinct
from every room value — that option is what makes `null` expressible at all.
Both of your worked examples are tests: clearing a stored `orderOverride: 3`
sends `{"order": null}` with `roomType` **absent**; choosing *Use analyzer
result* over a stored `"KITCHEN"` sends `{"roomType": null}` with `order`
**absent**.

A field touched and returned to its stored value stays dirty and is sent. The
domain already has correct stored-state no-op semantics; duplicating a
stored-value diff in the browser would be client logic pretending to be a
business rule.

## View model

`ReviewItem.correction` carries `analyzerRoomType`, `effectiveRoomType`,
`roomTypeOverride`, `orderOverride`, `corrected`, `canCorrect`.
`effectiveRoomType` comes from the domain helper **server-side** —
`roomTypeOverride ?? roomType` is never re-derived in client or view code.
`canCorrect` is presentation only: `AWAITING` and the viewer has `video:review`.

Decided and not-reviewable rows keep their values with `canCorrect: false` and
render **read-only** — "Corrected · analyzer read this as Bathroom, used as
Living room · order priority 2". No post-decision editing; refresh remains the
path to a new reviewable revision.

## Boundary

Room options are built in `page.tsx` from `ROOM_TYPES` + `humanizeRoomType` and
passed down as plain `{ value, label }` data. `correction-errors.ts` has zero
imports.

Clean-build scan of the client chunks — **all absent**: `ROOM_TYPES`,
`humanizeRoomType`, `isRoomType`, `effectiveRoomType`, `isCorrected`,
`AnalysisService`, `StoryboardService`, `@app/domain`, `@app/database`,
`PrismaClient`, `node:crypto`, `node:fs`, `node:util`, `authorizeOrganization`,
`CorrectionField`. **Positive control:** the `CorrectionPanel` literals *"Use
analyzer result"* and *"Order priority — lower numbers appear earlier"* are both
present in `static/chunks/app/properties/[propertyId]/review/page-*.js`.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **735/735** in 45 files (48 new) |
| `pnpm build` | **pass** — clean rebuild |
| `pnpm test:db` | **pass** — 27/27, unchanged |
| Bundle scan | **pass** — 15 symbols absent, positive control present |

**Zero diff** across all of `packages/` (no domain, `AnalysisService.correct`,
correction audit, schema, migration, storyboard eligibility/ordering/fingerprint,
or provider change) and across `apps/web/src/app/api/` (**no API contract
change** — the 3D-4a contract is untouched).

No defect was discovered by the build, the tests, or the scan.

### Coverage (48 new cases)

**Room field (4):** untouched omits the key; a chosen value is sent; clearing an
existing override sends `null` with the key present; clearing while the order is
untouched sends `roomType` only.

**Order field (5):** untouched omits; a set priority is sent as a number; a
changed priority sends the new value; emptying an existing priority sends
`null`; clearing while the room is untouched sends `order` only.

**Request shape (4):** the exact endpoint and `{organizationId, roomType, order}`;
Save disabled and no request when nothing is dirty; Save held while a non-empty
priority is `0` or `2.5` and enabled at `3`; ten forbidden lifecycle, identity
and internal fields each absent from the body.

**Interlock (9):** decisions available while clean; blocked after a room edit
and after an order edit; still blocked when an existing override is *cleared*;
**still blocked after a failed save**; a successful save requests
`router.refresh()` rather than unlocking locally; a click on a disabled Approve
sends nothing at all; any dirty member blocks a cluster's decision; discarding
restores the stored value and re-enables the decision without any request.

**Separation (2):** saving issues exactly one request, to the correction
endpoint; approving sends only `{organizationId, primaryAssetId}` with four
correction fields asserted absent.

**Failures (7):** `401`/`403`/`404`/`500` mapped with raw server text absent and
no refresh; a `422` rendering the API's own message; a network rejection; a
failed save preserving both entered values and succeeding on retry.

**Presentation (4):** no correction control for a decide-only member; no
decision control for a correct-only member; the analyzer's reading shown; the
select offers exactly the given options plus the clear choice.

**View model (8):** analyzer and effective rooms humanized server-side; fallback
when uncorrected; priority carried through present and absent; `canCorrect` true
for awaiting + `video:review`, false for CREATOR, false once decided while
keeping the values, false for a non-succeeded analysis; null correction for an
asset with no analysis.

**Error mapper (5):** each status branch; `422` passthrough for four real domain
refusals; fallbacks; no raw server detail for an unexpected status; no substring
classification.

## Documentation

Completion report, `CHANGELOG.md`, `docs/progress.md`, `docs/UXFlow.md`. No API
documentation change — the 3D-4a contract is unchanged. No new ADR: ADR-0015
already records the correction design, and the interlock is a presentation
decision, recorded here and in `UXFlow`.

## Phase 3 completion — evidence still to gather

`phase-3-complete` is **not** created. After this merges, closure requires
demonstrating on merged main: the analyzer's room visible; the override set and
cleared; the priority set and cleared; unsaved corrections unable to be approved;
correction and approval as separate audited actions; corrected values feeding
composition; the analyzer's `roomType`/`suggestedOrder` preserved;
correction-sensitive freshness intact; CREATOR unable to correct; decided
revisions read-only; all checks green; a clean bundle boundary — plus a Phase 3
report listing every 3A–3D milestone PR and merge commit.

## Known limitations

- Discarding is local only — it restores the server-provided values and clears
  dirty state, with no HTTP request. Reloading the page does the same.
- Client validation of the priority is usability only; the API remains
  authoritative.
- Completion tags exist locally only; remote publication remains blocked by
  `HTTP 403` and is **not** claimed.
