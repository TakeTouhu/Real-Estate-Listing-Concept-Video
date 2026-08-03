# ADR-0013: Deterministic storyboard ordering and duration allocation

- Status: Accepted
- Date: 2026-08-03
- Phase: 3C-2b

## Context

`docs/AIVideoPipeline.md` states the walkthrough order as "exterior → entrance →
hallway → living → dining → kitchen → bedroom → wet areas → storage → balcony"
and requires that only available photos are used, with no room synthesized. It
also says scenes are allocated "according to requested output length".

Neither statement is executable as written:

- The `RoomType` enum has fifteen members. The documented sequence names ten
  positions, one of which ("wet areas") is a category rather than an enum value,
  and three members — `CHILD_ROOM`, `STUDY`, `OTHER` — plus the `null` case
  appear nowhere in it.
- "According to requested output length" does not say what happens when the
  request cannot be met, nor what a scene's shortest and longest permissible
  duration are.

Both gaps have to be closed deterministically, because a storyboard that
reorders itself between two runs over identical inputs is not reviewable.

## Decision

### Ordering

The documented sequence is **completed**, not replaced. Ranks run over the
existing enum, adding nothing to the taxonomy:

`EXTERIOR` → `ENTRANCE` → `HALLWAY` → `LIVING_ROOM` → `DINING_ROOM` → `KITCHEN`
→ `BEDROOM` → `CHILD_ROOM` → `STUDY` → `BATHROOM` → `WASHROOM` → `TOILET` →
`STORAGE` → `BALCONY` → `OTHER`.

"Wet areas" resolves to the three members the enum already has, in the order the
enum declares them. `CHILD_ROOM` follows `BEDROOM` because it is a bedroom;
`STUDY` follows it; `OTHER` and a null room type sort last, as does any
`RoomType` added later that the rank table has not been taught — a fallback
rather than an invented position, so the function stays total.

Ties break by `suggestedOrder` ascending with nulls last, then `assetId`
ascending. Two null suggestions therefore fall through to `assetId` rather than
comparing equal, which is what makes the sort deterministic for exactly the
photos least likely to carry a suggestion.

**A repeated `assetId` is refused** (`VALIDATION_FAILED`) rather than
deduplicated. Two inputs claiming one asset means the caller built the set
wrongly; keeping one would hide that and quietly change the scene count. For
valid input the output is a permutation of the input: nothing added, nothing
dropped, nothing repeated.

### Duration allocation

Bounds are **always supplied by the caller**. This module defines no default and
no provider limits — those belong to Phase 4, where a real model's capabilities
are known.

Validation runs in two stages, and the order is the decision:

1. **Structural.** A scene count below one; a total, minimum, or maximum that is
   not a positive whole number; or a minimum above the maximum. These fail on
   their own terms and **carry no achievable range**. Quoting `n × min … n × max`
   over invalid numbers would present arithmetic on nonsense as advice.
2. **Range.** Only once the model is sound does an out-of-range request report
   `minimumAchievableDuration = sceneCount × minSeconds` and
   `maximumAchievableDuration = sceneCount × maxSeconds`, in `AppError.details`
   as well as the message.

Allocation gives each scene `floor(total / n)` seconds and distributes the
remainder one second at a time to the earliest scenes. Because the range check
has already established `n·min ≤ total ≤ n·max`, every value provably lands
within the bounds and the durations sum to exactly the requested total.

A request outside the achievable range **fails**. It is never met by reusing a
photo for a second scene and never quietly shortened: both hand back a video the
customer did not ask for.

### Minimum scene count

`requireMinimumScenes` is a **separate function** from allocation. Fewer than
three approved photos is a composition failure about the input set, not about
duration, so it carries a scene count and no duration vocabulary. Keeping the two
apart means neither rule can mask the other — a two-scene storyboard is refused
for being too small, not for an unachievable length.

## Consequences

- Composition over identical inputs yields an identical storyboard, whatever
  order the inputs arrive in. That is a precondition for review: a reviewer who
  reloads must see the same sequence.
- A future `RoomType` sorts last until the rank table is updated. It is placed
  conservatively rather than throwing, and the omission is visible rather than
  silent.
- Callers must decide their own per-scene bounds. Until Phase 4 supplies real
  ones, no default exists to be mistaken for a provider guarantee.
- Duration failures are machine-readable: `AppError.details` carries the range,
  so a UI can present it without parsing the message — the gap ADR-0012's
  companion TODO records for review errors does not exist here.
- Because structural failures carry no range, a caller cannot accidentally
  present `0 … 0` seconds as an achievable option.

## Alternatives considered

- **Deduplicating repeated assets** — rejected: it hides a caller defect and
  changes the scene count without saying so.
- **Clamping an out-of-range total to the nearest achievable value** — rejected:
  silent shortening. The customer asked for a length; if it cannot be met, they
  should be told the range, not handed a different video.
- **Reusing a photo with a different camera movement** to reach a longer total —
  permitted by `docs/AIVideoPipeline.md` "only when necessary", but deferred to
  Phase 4 where real provider capabilities exist. Designing reuse against
  invented limits would bake in assumptions nothing has verified.
- **Distributing the remainder to the longest or most important scenes** —
  rejected as premature: "importance" is not a property the analysis provides,
  and front-loading is deterministic and explainable.
