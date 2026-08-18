# Phase 3D-4a Completion Report — Correction HTTP contract

Merged milestone. Lifecycle facts (PR number, merge commit) are recorded in the
milestone table in `docs/progress.md`; this report is a technical snapshot.
Branch: `claude/real-estate-virtual-tour-phase-3d4a-hga252`
Base: `main` at `1e51453bc94b7ddb309a6f289fb670100936a26c` (merged Phase 3D-3)

The correction operation is now reachable over HTTP, and every nested analysis
action route stopped ignoring the property in its own URL.

## Milestone size — 609, under the re-cost

| File | Changed code lines |
| --- | --- |
| `tests/api/review-routes.test.ts` | 325 |
| `lib/asset-route.test.ts` | 100 |
| `analysis/correction/route.ts` | 77 |
| `lib/asset-route.ts` | 50 |
| `lib/analysis.ts` | 29 (−1) |
| `tests/api/analysis-routes.test.ts` | 14 |
| Four sibling routes (guard + import) | 14 (−5) |
| **Total** | **609** — 170 production + 439 tests |

Re-cost at **~684 and reported before implementation**; the actual is 11% under
that and well inside the ~800 threshold. Adding the correction cases to the
existing `review-routes.test.ts` rather than standing up a second harness saved
roughly 150 lines of duplicated fixture code — correction *is* a review action,
and the harness was already exactly right for it.

## Answering the question you asked first

**Yes — all five sibling handlers shared the defect.** Every one of them
destructured `propertyId` from the route params and never used it:

```
POST   …/assets/{assetId}/analysis          (analyze)
GET    …/assets/{assetId}/analysis          (read)
POST   …/assets/{assetId}/analysis/approve
POST   …/assets/{assetId}/analysis/reject
POST   …/assets/{assetId}/analysis/refresh
```

A same-organization asset filed under a different property could be approved,
rejected, refreshed or read through a hand-built URL. Not a cross-tenant leak —
the services resolve the asset organization-scoped — but wrong, and the same
class Phase 3C-6b hit.

The routes under `/api/assets/{assetId}/…` (complete, retry, download-url) are
**not** affected: they carry no property in the URL, so there is nothing to
mismatch. `…/assets/upload-url` already uses its `propertyId`.

## The fix

`apps/web/src/lib/asset-route.ts`:

```ts
export async function requireAssetInProperty(
  actorUserId, organizationId, propertyId, assetId,
): Promise<void> {
  const assets = await getPropertyServices().assets.list(actorUserId, organizationId, propertyId);
  if (!assets.some((asset) => asset.id === assetId)) {
    throw new AppError("NOT_FOUND", "Asset not found");
  }
}
```

Called at the top of all six handlers, immediately after `organizationId` is
read from the request.

Four properties this design holds, each covered by a test:

- **A mismatch is indistinguishable from a missing asset** — same code, same
  message, so nothing discloses that the asset exists elsewhere. An unknown
  property in the caller's organization lands in the same place.
- **It is URL integrity, not authorization.** `assets.list` authorizes
  organization membership, exactly as every read on these routes already did,
  and grants nothing new. The action's own `video:review` check still runs
  afterwards — a CREATOR on a correctly addressed asset still gets `403`, not a
  `404`.
- **No unrelated error is flattened.** There is deliberately no `try`/`catch`:
  authorization refusals and repository failures propagate untouched.
- **No domain signature changed.** `AnalysisService` was not redesigned for HTTP
  path semantics, and `propertyId` was not smuggled in as correction state.

It uses the existing `AssetService.list` — no new repository access from the web
layer, and no new domain method.

## The correction route

Thin. It authenticates, enforces route integrity, translates JSON's three states
onto `CorrectionField<T>`, and maps errors. The translation is the only logic it
owns:

```ts
function correctionField<T>(body, key): CorrectionField<T> | undefined {
  return key in body ? { set: body[key] as T | null } : undefined;
}
```

`key in body`, not truthiness — `null` means "clear", and `if (body.roomType)`
would silently turn a deliberate clear into a no-change. Only fields the caller
actually sent are spread into the input, because an `undefined` property is
still *present* and the domain distinguishes present from absent.

The room vocabulary, the priority rule, the empty-correction refusal, the
lifecycle, `video:review`, tenancy, provenance, no-op semantics and the audit
event are all left to `AnalysisService.correct`, **which is unchanged**.

## `correction-errors.ts` — deliberately not built

No client consumes it until 3D-4b, so shipping it here would be dead production
code. You explicitly allowed deferring it; I have. It appears in the 3D-4b plan.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **687/687** in 43 files (42 new) |
| `pnpm build` | **pass** — the correction route appears in the manifest |
| `pnpm test:db` | **pass** — 27/27, unchanged |

**Scope boundaries — zero diff** across all of `packages/` (so no schema,
migration, correction service, storyboard ordering, fingerprint or provider
change) and across `apps/web/src/app/properties/` and `globals.css` (no UI, no
CSS).

### Two defects found during development, both mine, both in tests

1. Adding the guard broke 25 existing API tests: the suites mock
   `@/lib/analysis` but not `@/lib/property`, so the helper reached the real
   Prisma-backed service. Fixed by mocking `@/lib/property` in both suites with
   a double that mirrors `AssetService.list` — real `authorizeOrganization`,
   then the in-memory repository — so the guard's authorization semantics are
   exercised rather than stubbed away.
2. I first wrote `expect([404, 422]).toContain(res.status)` for a
   not-yet-analyzed asset. That is a vague assertion hiding two different
   behaviours. Replaced with two precise cases: a never-analyzed asset returns
   `404` (route integrity passes, the domain finds no analysis), and an analysis
   forced to `PENDING` returns `422`.

### Coverage (42 new cases)

**Route-integrity helper (9):** a matching asset passes; a same-organization
asset under another property is refused; an unknown asset is refused the same
way; mismatch and missing produce identical code *and* message; neither the
foreign property id nor the foreign asset id appears in the error; `FORBIDDEN`,
`UNAUTHENTICATED` and a repository failure each propagate untouched; the list is
read exactly once.

**JSON translation (8):** set room; set order; an omitted key leaves the stored
override alone; an explicit `null` clears one field and only that field; both
fields at once; the empty body refused with nothing stored; a request restating
stored values returns `200` without moving `updatedAt`.

**Malformed values (8):** an unknown room refused with a planted hostile string
asserted **absent** from the response; `0`, `-2`, `2.5`, `"3"`, `{…}` and `[…]`
each refused with nothing stored; a non-JSON body returns `422`, never `500`.
Per your correction, no `NaN`/`±Infinity` HTTP cases — they cannot arrive
through valid JSON and are already covered at the domain boundary.

**Lifecycle, authorization, tenancy (6):** `401` unauthenticated; a REVIEWER
succeeds and a CREATOR gets `403`; `422` after a decision; `404` for a
never-analyzed asset; `422` for a `PENDING` analysis; `404` for an unknown asset
and for another organization's.

**Response hygiene (1):** the correction fields are correct and eight internal
markers — including `correctedBy` and `correctedAt` — are absent.

**Nested-route integrity across the route family (10):** a correctly addressed
asset still works; `approve`, `reject`, `refresh` and `correction` each refuse a
same-organization asset under another property with `404` **and leave it
untouched**; each returns the same `404` for a genuinely unknown asset; a
CREATOR on a correct URL still receives `403`, proving nothing is flattened.

## Documentation

Completion report, `docs/api-changes-phase-3d4a.md`, `CHANGELOG.md`,
`docs/progress.md`. The route hardening is documented as a **correctness fix**,
not a new API feature — no request or response contract changed for those five
handlers.

## Known limitations

- **No UI.** Nothing in the browser calls this endpoint yet; Phase 3D-4b adds
  the review-page controls, and **Phase 3 is not complete until it ships**.
- `correctedBy`/`correctedAt` remain unexposed pending a concrete requirement.
- Completion tags exist locally only; remote publication remains blocked by
  `HTTP 403` and is **not** claimed.
