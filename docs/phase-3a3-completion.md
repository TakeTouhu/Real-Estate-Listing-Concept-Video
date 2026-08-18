# Phase 3A-3 Completion Report — Analysis HTTP endpoints

Merged milestone. Lifecycle facts (PR number, merge commit) are recorded in the
milestone table in `docs/progress.md`; this report is a technical snapshot.
Branch: `claude/real-estate-virtual-tour-phase-3a3-hga252`
Base: `main` at `e49ae6aa3466fdeaf8d616084c7163a15f9466f5` (merged Phase 3A-2c)

Makes the completed `AnalysisService` reachable over HTTP. Final Phase 3A
milestone. No UI — that is Phase 3B.

## Milestone size — over target, disclosed

| File | Changed code lines |
| --- | --- |
| `tests/api/analysis-routes.test.ts` | 311 |
| `apps/web/src/lib/analysis.ts` | 86 |
| `.../assets/[assetId]/analysis/route.ts` | 57 |
| `.../assets/[assetId]/analysis/refresh/route.ts` | 37 |
| `apps/web/src/lib/request.ts` | 32 |
| `.../[propertyId]/analyses/route.ts` | 30 |
| `packages/ai-providers/src/index.ts` | 6 |
| `vitest.config.ts` | 6 |
| `tsconfig.base.json` | 4 |
| `apps/web/next.config.mjs`, `apps/web/package.json` | 2 |
| **Total** | **571** |

Estimated ≈445, delivered 571, against a ~500 target. The test file came to 311
against an estimated 220; production code is **260 lines** and landed close to
its 200-line estimate.

As in 3A-2b, roughly 150 of the test lines are fixtures (`StubProvider`,
`MapStorage`, `seed`, the `beforeEach` wiring) shared by all 13 route tests.
Cutting tests to reach 500 would mean dropping tenant-isolation or
response-hygiene coverage on a newly public HTTP surface, which is the last
place to economize. **The reviewer should decide whether to accept the overage.**

## Deviations from the approved plan

Three, all discovered by reading the existing code rather than assumed, and all
consequences of rules that outrank my original sketch.

### 1. `organizationId` is caller-supplied, not session-derived

The plan said "no client-supplied organization id — it comes from the session".
**That is not possible in this codebase**: a user may belong to several
organizations and the session carries no active-organization concept
(`getCurrentUser` returns user + session only). Every existing tenant-scoped
route — `/api/properties`, `/api/assets/*` — takes `organizationId` from the
request and verifies membership.

Safety is unaffected: a forged or guessed id fails `authorizeOrganization` with
`403`, and every repository read is scoped to the organization, so a foreign
asset is `404`. Inventing a session-scoped active organization would be a
cross-cutting identity change well outside this milestone.

The convention is now recorded in **ADR-0010 — organization context
resolution**, including the standing obligation it creates: because the id is
attacker-controlled input, every tenant-scoped endpoint must carry
cross-tenant tests.

### 2. `POST` returns `200`, never `201`

Distinguishing "created" from "returned the existing one" is a business fact
only `AnalysisService` knows. Inferring it in the route — comparing `createdAt`
to `updatedAt`, say — would place a business decision in the web layer, which
the thin-adapter rule forbids. `200` in both cases.

### 3. `422` rather than `400`/`409`

Statuses come from the shared `AppError` → HTTP mapping, where
`VALIDATION_FAILED` is 422. Re-mapping a non-`READY` asset to `409` would
require the route to interpret *why* the service refused — the same violation.

## Deferred from the plan: rate limiting

The approved plan included rate-limiting the two `POST` routes. **It is not
implemented**, and that is a deliberate call rather than an omission:

- **No rate limiter exists anywhere in this codebase.** Login, registration, and
  upload — all named in `CLAUDE.md` — are currently unlimited.
- Building one only for analysis would be a new cross-cutting component
  (~110 lines with tests) applied to one of four surfaces that need it, which
  reads as protection without being it, and would push this milestone past 680
  lines.

Recorded in `docs/decisions/TODO.md` as a dedicated cross-cutting milestone
covering login, uploads, analysis, and generation together. **Flagging it for an
explicit decision:** say the word and I will add it here instead.

## Thin-adapter compliance

Every handler does only: authenticate → validate shape → delegate → map → let
the shared error mapper translate. No handler branches on analysis status, role,
tenancy, or idempotency. Concretely:

- Authorization lives in `AnalysisService` via `authorizeOrganization`; routes
  never inspect roles.
- READY-only eligibility, idempotency, refresh semantics, duplicate grouping and
  ordering are untouched by the web layer.
- `lib/request.ts` validates only that `organizationId` is a plausibly-shaped
  string; whether the caller may use it is decided by the domain.
- `toAnalysisDto` is pure field mapping plus two derived booleans computed with
  the domain's own helpers.

`AnalysisService` is unchanged in this milestone — the domain diff is zero.

## Also included

`packages/ai-providers/src/index.ts` did not export
`DeterministicImageAnalysisProvider` or `createImageAnalysisProvider`; the
barrel still held only the Phase 0 placeholder, so the adapter shipped in 3A-1
was unreachable from outside the package. Exporting them (6 lines) was necessary
to wire the service and is a genuine gap fix, not scope creep.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — root + 11 workspaces, 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **221/221** in 21 files (13 new) |
| `pnpm build` | **pass** — all three routes present in the build output |
| `pnpm test:db` | **pass** — 5/5 against live PostgreSQL 16 |

**No Prisma schema or migration change** — `git status packages/database/prisma/`
clean.

### Route tests

The tests stub *only* session resolution. The routes run against a real
`AnalysisService` over in-memory repositories, so authorization and tenant
isolation are exercised for real rather than mocked away.

| Area | Coverage |
| --- | --- |
| Happy path | `200` + `SUCCEEDED` DTO; second `POST` is idempotent with the provider called once |
| Refresh | recomputes, provider called twice; `REVIEWER` gets `403` |
| Eligibility | non-`READY` asset → `422`; unknown asset → `404`; missing analysis → `404` |
| Reads | single analysis and property list; `REVIEWER` may read both |
| Authentication | `401` on all four routes when unauthenticated |
| Authorization | non-member `403` on all four routes |
| Tenant isolation | a member of two organizations still gets `404` for the other's asset, and an empty list for its property |
| Validation | missing, empty, and non-JSON `organizationId` → `422`, never a 500 |
| Response hygiene | serialized body contains no storage key, no `organizationId`, no provider name, no `reviewedBy` |

## Documentation

| Item | Status |
| --- | --- |
| Completion report | This document |
| ADR | **New** — `docs/decisions/0010-organization-context-resolution.md` |
| API change summary | **New** — `docs/api-changes-phase-3a3.md`; four endpoints are a real API surface change |
| Change log | Updated — `CHANGELOG.md` |
| Progress | Updated — `docs/progress.md`, incl. the 3A-2c merge commit and tag record |
| Sequence diagram | Updated — `docs/sequence-analysis-lifecycle.md` v1.3, HTTP entry point |
| TODO | Updated — rate limiting recorded |
| Architecture diagram | **Unchanged** — no new module or boundary |
| ER diagram | **Unchanged** — no schema change |
| Migration notes | **Unchanged** — no migration |

## Known limitations

- **No rate limiting** — see above.
- No review or approval endpoints; `reviewedBy` / `reviewedAt` stay unwritten
  until Phase 3B. Mandatory human review is unaffected: no AI output can be
  published in any phase implemented so far.
- Analysis is synchronous inside the request. Acceptable while the only provider
  is the offline deterministic adapter; a real vision vendor needs the Phase 4
  job queue rather than a blocking HTTP call. Worth deciding before any vendor
  integration.
- No OpenAPI document; the API change summary is the contract record, as in
  Phase 2.
- Transactional outbox and concurrent provider-call deduplication remain open
  TODO items, unchanged here.
- Remote publication of all seven `phase-*-complete` tags is still blocked by
  `HTTP 403` on tag refs. They exist locally only and are **not** claimed to
  exist on GitHub; see `docs/progress.md`.
