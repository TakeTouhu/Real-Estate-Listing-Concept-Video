# Phase 3C-5b Completion Report — Storyboard compose, read, and project list

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3c5b-hga252`
Base: `main` at `afb9fbeb373b8b14cef989bc4a4210de753652b9` (merged Phase 3C-5a)

Completes the storyboard HTTP surface: freshness in the domain, compose and read
endpoints, and the property-level project list the product UI needs to
rediscover its projects through the API.

## Milestone size — within the re-cost

| File | Changed code lines |
| --- | --- |
| `tests/api/storyboard-routes.test.ts` | 358 (−4) |
| `storyboard-service.test.ts` | 122 (−1) |
| `storyboard-service.ts` | 88 (−8) |
| `.../video-projects/[projectId]/storyboard/route.ts` | 74 |
| `apps/web/src/lib/storyboard.ts` | 57 (−1) |
| `.../properties/[propertyId]/video-projects/route.ts` | 33 |
| **Total** | **732** — 252 production + 480 tests |

Re-cost at **~711** before implementation; the actual is **732**, a 3% variance
— the closest estimate of the phase, and well inside the ~800 threshold that
would have required stopping. Above the ~500 guideline by design: this is one
coherent HTTP capability, and per the product-completion directive no
functionality or test was removed to shrink it.

## Freshness — one comparison, two callers

```ts
private async freshnessOf(...): Promise<{ project; freshness: "FRESH" | "STALE" | "NEVER_COMPOSED" }>
async isFresh(...): Promise<boolean>      // freshness === "FRESH"
async assertFresh(...): Promise<void>     // throws on the other two, with distinct messages
```

The fingerprint comparison exists **once**. `assertFresh` keeps its two distinct
messages by reading the reason rather than repeating the comparison, and remains
the Phase 4 hard gate.

`isFresh` returns `false` for exactly two reasons — nothing composed, or the
inputs moved. **Everything else propagates**, proven by a test that drives an
authorization failure, a `NOT_FOUND`, a repository error, and the
duplicate-approved-input invariant through `isFresh` and asserts each throws
rather than reporting "not fresh". A broken system must never read as a merely
outdated storyboard.

## Two service reads behind the endpoints

`getStoryboard` and `listProjects` were added so the routes delegate through the
application boundary instead of touching repositories — the pattern established
in 3C-5a. They are the means of implementing the two approved read endpoints,
not new product features.

`listProjects` returns `NOT_FOUND` for an unknown or foreign property rather
than an empty list: an empty list would confirm the property does not exist *in
this tenant*, which is the disclosure the `404` exists to prevent. **A test I
first wrote asserted the empty-list behaviour and failed — the code was right
and the expectation was wrong.**

## HTTP exposure

The scene DTO carries `id`, `assetId`, `position`, `durationSeconds`,
`roomType`, and `sourceAnalysisRevision` — and a test asserts that is *exactly*
the key set. **No `compiledPrompt` in any form**, no preservation constraints,
no system negatives, no moderator identity, no provider data, no storage keys,
no `organizationId`, no `compositionFingerprint`. `fresh` is a boolean; the
digest never leaves the server.

A never-composed project reads as `scenes: []`, `fresh: false` using existing
semantics — no status was invented.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **468/468** in 34 files (28 new) |
| `pnpm build` | **pass** — both route files in the build output |
| `pnpm test:db` | **pass** — 24/24, unchanged |
| `packages/database/` · Prisma schema · migrations · `domain/src/analysis/` · review routes | **zero diff** |

No defect was discovered by the build. One test-authoring error was found and
corrected during development, described above.

### Coverage (28 new cases)

**Domain (10):** exact match true; no fingerprint false; revision change,
addition, and removal each false; authorization, `NOT_FOUND`, repository
failure, and the duplicate invariant each propagate; `assertFresh` agrees with
`isFresh` on every outcome; uncomposed read; composed read; member read and
foreign `404`; list; unknown property `404`.

**Compose API (8):** `401`; `REVIEWER` denied then writer succeeds; unknown
project `404`; five malformed-bound shapes `422` with nothing composed;
minimum-scene `422`; duration range `422` carrying both achievable figures;
moderation rejection sanitized — a planted marker absent from the response while
the `ADDS_PEOPLE_OR_LOGOS` code is present; success returning ordered scenes with
the exact safe key set.

**Read API (6):** `401`; any member including `REVIEWER`; unknown project `404`;
uncomposed → `[]` and `fresh: false`; composed → three scenes and `fresh: true`,
then `fresh: false` after a fourth approval; no prompt, provider, storage, or
tenant internals in the body.

**List API (4):** `401`; any member lists a property's projects; unknown and
foreign property both `404`; safe DTOs only.

## Documentation

Completion report, `docs/api-changes-phase-3c5.md` (all three endpoints),
`CHANGELOG.md`, `docs/progress.md`. No ADR, no architecture change, no schema or
migration change.

## Known limitations

- No UI consumes these endpoints yet — Phase 3C-6.
- The duration bounds remain caller-supplied orchestration inputs; **Phase 4
  must validate real provider capability before any provider call** (TODO).
- No rate limiting anywhere.
- Remote publication of all eighteen `phase-*-complete` tags remains blocked by
  `HTTP 403`. They exist locally only and are **not** claimed to exist on GitHub.
