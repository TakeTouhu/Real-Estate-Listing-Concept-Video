# Phase 3C-6a Completion Report — Video-project discovery and creation UI

Merged milestone. Lifecycle facts (PR number, merge commit) are recorded in the
milestone table in `docs/progress.md`; this report is a technical snapshot.
Branch: `claude/real-estate-virtual-tour-phase-3c6a-hga252`
Base: `main` at `37df1b77418012907011d69bed9508aded1252ca` (merged Phase 3C-5b)

The first UI that consumes the Phase 3C-5 storyboard contract. A customer can
now reach Videos from a property, see every video project it has, and create
one — entirely in the browser.

## Milestone size — reported before implementation, and it still landed over

| File | Changed code lines |
| --- | --- |
| `video-projects/create-panel.test.tsx` | 231 |
| `video-projects/create-panel.tsx` | 189 |
| `video-projects/projects-view.test.tsx` | 154 |
| `video-projects/projects-view.tsx` | 107 |
| `video-projects/page.tsx` | 66 |
| `lib/project-errors.ts` | 38 |
| `lib/project-errors.test.ts` | 37 |
| `app/globals.css` | 20 |
| `properties/[propertyId]/page.tsx` | 3 |
| **Total** | **845** — 423 production + 422 tests |

Approved at **~430**. I re-cost to **~620 before writing any code and reported
that number**, because the mandated coverage — *"authorization presentation:
user without `property:write` receives no create controls in markup"* and
*"project presentation: multiple projects rendered correctly"* — cannot be
asserted against an async Server Component with the existing jsdom
infrastructure. That forced the list markup out of `page.tsx` into a
synchronous `ProjectsView` with its own test file.

The actual is **845**, a further **36% over my own re-cost**. The overrun is in
the two test files (385 lines against ~240 estimated): the approved test list
has fifteen distinct required cases for the create panel and nine for the view,
and each `it` block with its arrange/act/assert costs 12–18 lines in this
codebase's style. **I did not delete any required test to close the gap** —
that was your explicit instruction, and cutting the DTO-hygiene or
authorization-presentation cases is exactly the wrong economy. If you want it
smaller, the honest levers are the three cases beyond your required list
(whitespace-only input, optional-field inclusion, and the duration-shape
sweep), worth roughly 45 lines; say the word and I will drop them.

## What was built

**`/properties/{propertyId}/video-projects`.** `page.tsx` is data loading only:
resolve the user, resolve the property across the organizations they belong to
using the loop both existing property pages already use, read through
`getStoryboardService().listProjects`, and hand DTOs to the view. No repository
is touched, and the service re-checks membership independently.

**`ProjectsView`** renders the list and gates the create panel. It is a plain
synchronous component — not a Client Component — so the browser bundle never
sees it, but a jsdom test can render it directly. Each row shows name, status,
target length, aspect ratio, resolution, and the customer's own camera motion,
prompt, and negative prompt where set.

A property may hold **any number** of projects. There is no active, default, or
primary one; no pagination, search, filter, or sorting control; and the empty
state says nothing exists rather than implying one does. **Rows carry no link**
— the detail route arrives in 3C-6b, and a test asserts the view renders zero
anchors so nobody can wire up a dead link by accident.

**`CreateProjectPanel`** posts to `POST /api/properties/{propertyId}/video-projects`.
Name, target length, aspect ratio, and resolution are required, and the button
is unusable until all four are filled and the length parses as a whole number
above zero. Camera motion, prompt, and negative prompt are optional and are
sent only when they carry text. On `201` the form clears and `router.refresh()`
re-renders from the database — the server owns what the list contains, so
nothing is inserted locally.

## Rules held, and how

**No lifecycle state leaves the client.** The request body is built field by
field from `CreateProjectInput`; a test asserts `status`,
`compositionFingerprint`, `scenes`, `createdBy`, `compiledPrompt`, `propertyId`,
and `id` are each absent from what is actually sent.

**No internal data reaches the markup.** A test reads the rendered
`innerHTML` and asserts it contains no organization id, fingerprint, `sha256`,
compiled prompt, preservation or negative-constraint vocabulary, provider name,
storage key, or `createdBy`. The DTO does not carry them (ADR-0014), so the
assertion is a regression guard rather than a filter.

**No invented provider capability.** Aspect ratio and resolution are free text.
The placeholders (`16:9`, `1080p`) show the shape of the string; nothing
constrains, validates, or suggests what a provider accepts, which stays Phase
4's to establish.

**Authorization is presentational as well as enforced.** A member without
`property:write` gets no create markup at all — the test asserts zero `input`
and zero `button` elements, not a disabled control — plus one explanatory line,
and can still read the list. The client re-derives nothing; `hasPermission` is
evaluated on the server and passed in as a boolean.

**No review requirement is bypassed.** This milestone adds no approve, reject,
refresh, compose, or generate control. It cannot influence which analyses are
eligible, because it has no parameter that reaches composition.

## The client/server boundary

`project-errors.ts` has **zero imports**, for the reason `decision-errors.ts`
does: in Phase 3B-3b a Client Component pulled `@app/domain` and `node:util`
into the browser bundle and only `next build` caught it.

I checked rather than assumed. After a clean rebuild, the browser chunks under
`.next/static/chunks/` contain **none** of `PRESERVATION_RULES`,
`computeCompositionFingerprint`, `selectEligibleAnalyses`, `WAVESPEED_API_KEY`,
`PrismaClient`, `@app/database`, `node:crypto`, `createOfflinePromptModerator`,
`ROLE_PERMISSIONS`, `MODERATION_MESSAGES`, or `storyboards.projects`. The new
page's client chunk does contain `Create project`, which confirms the scan read
the right files. First Load JS is 104 kB, matching the existing property page.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | **pass** — 0 errors |
| `pnpm lint` | **pass** — 0 errors, 0 warnings |
| `pnpm test` | **pass** — **497/497** in 37 files (29 new) |
| `pnpm build` | **pass** — clean rebuild; new route present |
| `pnpm test:db` | **pass** — 24/24, unchanged |
| Browser bundle scan | **pass** — no domain or server symbol |
| `packages/` · Prisma schema · migrations · API routes · domain | **zero diff** |

No defect was discovered — by the build, the bundle scan, or the tests. Nothing
outside `apps/web/` changed.

### Coverage (29 new cases)

**Error mapper (5):** `401`/`403`/`404` by status; `422` message passthrough for
two different refusals; missing-message fallback; unexpected status, `429`, and
no-status-at-all fallback; an explicit case proving no branch reads the message
text.

**Create panel (15):** the button stays disabled through each required field in
turn; a zero, fractional, and non-numeric duration each keep it disabled and a
valid one enables it; whitespace does not count as filled; the endpoint and the
exact request body; `durationSeconds` is sent as a number; optional fields
appear only when they carry text; seven forbidden lifecycle and internal fields
are each absent; `201` clears the form and refreshes once; a failure does not
refresh; `401`/`403`/`404`/`500` each render the mapped message with the raw
server text absent; `422` renders the API's own message; a network rejection
renders the generic message without the thrown text; and a failed attempt leaves
the form filled and usable, with the retry succeeding and clearing the error.

**Projects view (9):** three projects all render with no active or default one;
a single project renders identically to three; the empty state; every
product-facing setting appears; each of the three persisted statuses gets a
label and none is invented; zero anchors; ten internal markers absent from the
markup; a writer receives the create controls; a non-writer receives no input or
button at all but still reads the list.

## Documentation

Completion report, `CHANGELOG.md`, `docs/progress.md`, `docs/UXFlow.md` (the new
Videos navigation and the implemented behaviour), and `docs/decisions/TODO.md`.

No ADR: this milestone makes no architectural decision the existing records do
not already cover — the client/server boundary rule is ADR-recorded from 3B-3b,
and the server-component-reads-through-the-service-boundary rule was your
Decision 1, recorded here and in the CHANGELOG rather than as a new ADR. No API
change summary, schema note, migration note, or ER/architecture diagram change:
no contract outside the UI moved.

## Known limitations

- No project detail page, storyboard preview, compose control, freshness
  presentation, or recompose interaction — **Phase 3C-6b**.
- **Rename, edit settings, and delete are deferred, not judged unnecessary.** A
  customer who mistypes a duration or resolution today can only create another
  project. Recorded in `docs/decisions/TODO.md` for commercial-launch readiness
  review, with the endpoints, authorization, audit, and fingerprint-invalidation
  question that closing it requires.
- Compose duration bounds still have no product-level source; 3C-6b makes them
  explicit required inputs with no default, and Phase 4 must replace them with
  real provider capability.
- No rate limiting anywhere.
- Remote publication of all nineteen `phase-*-complete` tags remains blocked by
  `HTTP 403`. They exist locally only and are **not** claimed to exist on GitHub.
