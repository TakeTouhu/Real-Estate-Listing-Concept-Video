# Phase 3C-4 Completion Report — Storyboard orchestration

Status: **implemented, awaiting review**
Branch: `claude/real-estate-virtual-tour-phase-3c4-hga252`
Base: `main` at `0b39eb1f4eb98e4d8b4e7e8841c05c1cb31ac1c3` (merged Phase 3C-3)

`StoryboardService` with two methods — `compose` and `assertFresh` — plus focused
unit tests. Orchestration only: every rule stays in the primitive that already
owns it.

## Milestone size — over the gate, reported not absorbed

| File | Changed code lines |
| --- | --- |
| `storyboard-service.test.ts` | 395 |
| `storyboard-service.ts` | 207 |
| `index.ts` | 1 |
| **Total** | **603** — 208 production + 395 tests |

Re-cost at ~410 (155 production + 250 tests) before implementation, so this is
**20% over the ~500 gate and 47% over my own estimate**. Where it went:

- **Tests 395 against 250.** The typed inline harness is ~95 lines on its own —
  five doubles (memberships, audit log, assets, analyses, both storyboard
  repositories) each needing a shape the compiler accepts. Your required list
  has 24 assertions; they fit into 22 cases.
- **Service 207 against 155.** The compile-once path and its rationale comment,
  plus the scene-row mapping, are longer than a bare orchestration sketch.

I did not delete required coverage to reach the number. If you want it under
500, the honest lever is the harness: dropping strict typing on the doubles
(`as any`-style stubs) saves ~40 lines at the cost of the type safety that
caught two wiring mistakes while writing them. I would rather keep the typing
and report the overrun.

## Moderation — the API inspection you asked for

I inspected `compileScenePrompt` before coding. It moderates internally, once
per non-empty field, then returns the structure.

**The allow-all moderator was rejected.** Passing a permissive moderator into
every scene compilation would put an object named like a moderation boundary
into a path that performs no moderation — exactly the misleading boundary you
warned about, and a silent failure if someone later removed the service-level
call.

**What it does instead:** compile **once** with the real moderator, using the
first scene's facts. That single call performs the moderation, once per field.
The remaining scenes reuse the verified result with their own `sceneFacts`
substituted and the arrays copied. No allow-all object exists anywhere; the
3C-3 public contract is unchanged and used exactly as written.

Nothing was weakened: both user-authored fields are moderated, rejection stays
sanitized with `{ field, code }` findings, rejection is terminal, and ADR-0014's
separation is preserved through to persistence.

## The four approved decisions

1. **Bounds** are a `compose(..., bounds)` parameter. The service defines no
   default and no provider limit.
2. **Moderation** runs once per field per compose — asserted by a test that
   composes three scenes and expects exactly `["prompt", "negativePrompt"]`.
3. **Persistence** stores `JSON.stringify(compiledPrompt)` in the existing
   `storyboard_scenes.compiledPrompt` column. Encoding only — a test parses every
   stored scene and asserts all five parts survive, so Phase 4 consumes the
   reviewed prompt rather than recompiling something different.
4. **Audit** is exactly one `storyboard.composed` event on success, with scene
   count and fingerprint. None on failure.

## Failure safety without a transaction

Writes are ordered: `replaceForProject` (already atomic internally, 3C-1), then
the project update, then the audit. A scene-write failure therefore leaves the
project `DRAFT` with a null fingerprint and no audit entry — asserted by a test.

**If the project update fails after the scenes are written**, the resulting
state is: scenes persisted, project still `DRAFT` with the previous fingerprint,
no audit event. That storyboard is not usable by Phase 4, because `assertFresh`
refuses a project with no stored fingerprint, and the next `compose` replaces
the scenes wholesale. No recovery infrastructure was built, as instructed.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **421/421** in 33 files (22 new) |
| `pnpm build` | **pass** |
| `pnpm test:db` | **pass** — 24/24, unchanged |
| `packages/database/` · `apps/` · Prisma schema · migrations · `analysis/` | **zero diff** |

No defect was discovered by the tests or the build in this milestone.

### Test coverage (22 cases against your 24 required assertions)

Authorization and tenancy — non-member denied, `REVIEWER` denied, `CREATOR`
succeeds, unknown and foreign project both `NOT_FOUND`. Delegation — only
approved analyses become scenes; the duplicate invariant propagates; below the
minimum fails; **ordering is asserted against `orderScenes`' own output** rather
than a restated sequence; durations come from the supplied bounds and an
out-of-range request preserves `minimumAchievableDuration` /
`maximumAchievableDuration`. Prompts — moderation once per field; every stored
scene's JSON round-trips with all five parts; a rejection persists nothing,
audits nothing, and leaks no text. Persistence — canonical fingerprint stored,
project marked ready, one audit event, none on failure, scene-write failure
leaves the project unready. Freshness — unchanged inputs pass; revision change,
addition, and removal each fail; a missing fingerprint fails; membership is
required and a foreign project is `NOT_FOUND`.

Detailed ordering, duration, eligibility, and moderation matrices are **not**
repeated here — they are covered by 3C-2 and 3C-3.

## Documentation

Completion report, `CHANGELOG.md`, `docs/progress.md`. **No architecture or ADR
changes** — no boundary moved, and the decisions were settled in review.

## Known limitations

- Nothing calls `StoryboardService` yet; 3C-5 (HTTP) or Phase 4 is the first
  consumer.
- The project-update-after-scenes window described above is accepted for MVP.
- Deferred as agreed: cross-entity transaction, automatic recomposition, manual
  scene-edit preservation, idempotency keys, a reusable in-memory double,
  provider capability tables, new statuses, HTTP, UI, provider integration, and
  additional audit infrastructure.
- Remote publication of all sixteen `phase-*-complete` tags remains blocked by
  `HTTP 403`. They exist locally only and are **not** claimed to exist on GitHub.
