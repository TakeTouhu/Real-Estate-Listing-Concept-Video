# Phase 3C-5a Completion Report — Video-project creation path

Merged milestone. Lifecycle facts (PR number, merge commit) are recorded in the
milestone table in `docs/progress.md`; this report is a technical snapshot.
Branch: `claude/real-estate-virtual-tour-phase-3c5a-hga252`
Base: `main` at `003edaf97dbcc651e7ba66affbc06ac523e1fe8d` (merged Phase 3C-4)

The minimum path that brings a `VideoProject` into existence:
`StoryboardService.createProject`, its `PropertyRepository` dependency, the web
wiring and project DTO, and `POST /api/properties/{propertyId}/video-projects`.

## Milestone size — over the gate, reported not absorbed

| File | Changed code lines |
| --- | --- |
| `tests/api/storyboard-routes.test.ts` | 284 |
| `storyboard-service.test.ts` | 109 (−2) |
| `storyboard-service.ts` | 78 (−1) |
| `apps/web/src/lib/storyboard.ts` | 78 |
| `.../api/properties/[propertyId]/video-projects/route.ts` | 56 |
| `apps/web/src/lib/request.ts` | 18 |
| **Total** | **623** — 230 production + 393 tests |

Estimated **377** and re-confirmed at 377 against the actual files before
writing code, so I proceeded. The actual is **65% over that estimate and 25%
over the ~500 gate**. The whole miss is in one place:

- **API tests 284 against 120.** I costed the harness at ~60 assuming
  `createTestDeps` covered most of it. It did not: the file needs three
  registered users with distinct roles, two organizations, two properties in
  different tenants, and a project store — ~90 lines before the first
  assertion — plus 12 cases. The domain side landed almost exactly on estimate
  (187 against ~160).

Nothing was removed to reach a number, and the security and tenant tests you
protected are all present.

## `createProject`

Authorizes `property:write`, resolves the property through organization-scoped
access, and returns `NOT_FOUND` when it is unknown **or another tenant's**.
Validation is structural only — a non-empty name, a positive whole number of
seconds, and non-empty format strings. **No provider capability rule is
applied**: a test creates a 987-second 21:9 8k project successfully, because
judging that is Phase 4's job and inventing a limit here would be the
provisional capability table you have ruled out twice.

### Lifecycle state is unrepresentable, not ignored

`CreateProjectInput` has no `status`, no `compositionFingerprint`, and no
scenes. A client cannot present a project as already composed because there is
no field to put it in — the same technique as `VideoProjectUpdate` in 3C-1. Two
tests cover it anyway: one passes a hostile object cast through the type at the
service, one posts the same fields over HTTP, and both confirm the stored
project is `DRAFT` with a null fingerprint.

A new project is always `DRAFT`, unfingerprinted, and sceneless.

## The route

A thin adapter. It reads the body's shape — `requiredString`,
`requiredPositiveInteger`, `optionalString` — and delegates. It does not check
whether the property exists, whether the caller may write, or whether any
setting is achievable; `StoryboardService` owns all three. `201` on success.

### DTO hygiene

`VideoProjectDto` omits `organizationId`, `compositionFingerprint`, and
`createdBy`. **Nothing about the compiled prompt, the preservation rules, the
system negative constraints, or the moderator's identity is exposed** — those
are server-side generation data (ADR-0014), and a test asserts none of those
strings appears anywhere in the serialized response. The customer's own `prompt`
and `negativePrompt` are returned, since they are the text the customer
submitted.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **440/440** in 34 files (19 new) |
| `pnpm build` | **pass** — the route appears in the build output |
| `pnpm test:db` | **pass** — 24/24, unchanged |
| Prisma schema · migrations · `domain/src/analysis/` · review HTTP routes | **zero diff** |

No new database model, no new repository abstraction, no reusable in-memory
storyboard repository. No defect was discovered by the tests or the build.

### Coverage

**Domain (7 new cases):** authorized creation succeeds with the name trimmed;
project starts `DRAFT` with no fingerprint and no scenes; a hostile input cannot
set lifecycle state; non-member and `REVIEWER` both denied; unknown and foreign
property both `NOT_FOUND`; blank name, fractional duration, and empty resolution
each rejected; no provider capability rule applied.

**API (12 cases):** `401` unauthenticated; `403` for `REVIEWER` and for a
non-member; `201` for a permitted writer; `404` for an unknown property; `404`
— not `403` — for another organization's property, with nothing persisted;
`403` when naming an organization the caller does not belong to; `201` response
shape with `DRAFT` status and no scenes; client lifecycle fields ignored end to
end; no provider capability rule; eight malformed-body cases all `422` with
nothing persisted; response hygiene across tenant, persistence, provider, and
prompt internals.

Deep domain matrices already covered by 3C-2/3C-3/3C-4 are not repeated.

## Documentation

Completion report, `CHANGELOG.md`, `docs/progress.md`, and one
`docs/decisions/TODO.md` entry recording that Phase 4 must validate duration,
aspect ratio, and resolution against real provider capability before any
provider call — nothing in Phase 3C does.

## Deferred to 3C-5b, as agreed

`isFresh`, the `assertFresh` refactor, the compose and read endpoints,
duration-bound HTTP handling, scene DTOs, the freshness response, and the
compiled-storyboard read API. Also still deferred: 3C-6 UI and Phase 4.

## Known limitations

- A created project cannot yet be composed over HTTP — 3C-5b adds that. It is
  inert until then, and `assertFresh` already refuses a project with no
  fingerprint.
- No way to list or edit projects over HTTP; the 3C-6 page will read them
  server-side, as the review page does today.
- Remote publication of all seventeen `phase-*-complete` tags remains blocked by
  `HTTP 403`. They exist locally only and are **not** claimed to exist on GitHub.
