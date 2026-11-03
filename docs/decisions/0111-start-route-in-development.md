# ADR-0111 — The start route, built only where the test provider is

Status: Accepted (GS-10c, 2026-11-02). The third milestone of row GS-10 of the
generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`). Builds on ADR-0088 (the
start service), ADR-0090 (the test provider's route kit), ADR-0068 (a form
post that commits Units), ADR-0109 (the start offer) and ADR-0110 (one video
of a project at a time).

## Context

The start service decides whether a member may start the video a project's
storyboard describes, and its offer says what that start would be. Nothing
outside tests constructs either, so nothing a person can reach starts a video.

The plan's approval says the start screen and its route appear only in
development with the test provider, and are hidden or refused in production.
Paid Provider Activation, production Provider credentials, production paid AI
calls, the production scheduler and live Stripe charges stay BLOCKED
(ADR-0054 Decision 7). The test provider's route kit already refuses to be
built in production, given or ambient, and unless `VIDEO_PROVIDER` is `fake`
(ADR-0090); the development pipeline (ADR-0108) is built behind the same guard.

GS-10 was split into four milestones. This one is the web app's composition of
the start and its route; GS-10d adds the start page that posts to it.

## Decision 1 — The route: `POST /api/video-projects/{projectId}/generations`

A form post from the start page, in this order:

1. **Where the start is not built, there is no start.** A post is answered
   `404 NOT_FOUND`, a JSON error like the API's others, before the request,
   the session or the form is read. This does not hide that the path is
   known (only `POST` is exported, so a `GET` answers `405`); it makes sure
   nothing behind it runs.
2. **The post must come from this site** (`isSameOriginPost`, ADR-0068
   Decision 4): `403` otherwise, before the session is read.
3. **A signed-out visitor** is sent to sign in (`303 /login`).
4. **A body that is not a form**, or a `propertyId` or project id in the path
   that is not an id, is `422 VALIDATION_FAILED`: the ids say where to send
   the customer.
5. **A form that cannot be a start** lands on the start page saying so, and
   nothing is started.
6. **The start service decides**, as the signed-in member: permissions, reach,
   the replay, the project's video (ADR-0110), the storyboard and quality the
   customer confirmed, the length and the Units. Where its answer sends the
   customer is Decision 4.

The path is the one `docs/API.md` planned for a generation. Like the purchase
route, it answers a form, not JSON, so the start page works without scripts
and a reload after the answer does not post again.

## Decision 2 — The composition: only where the test provider's route is

`getGenerationStartService()` in `apps/web/src/lib/generation-start.ts` builds
the start only when `createFakeRouteKit` hands out the test provider's route,
and returns `null` where the kit's own guard refuses it (`CONFIGURATION_ERROR`):
in production, given or ambient, and with any provider but `fake`. Any other
failure is thrown. It is built once per process.

- **The qualities are the kit's**: Normal and HQ, from the same route policy the
  development pipeline hands its paid-submission gate (ADR-0089), so a start is
  made only at a quality a submission would be allowed.
- Everything else is the web app's own: the identity services, the storyboard
  service as the storyboard reader (its freshness is the one the project page
  shows), and the Prisma repositories for Properties, subscriptions, the Unit
  ledger and the start commit.
- **No new environment variable.** `VIDEO_PROVIDER` already defaults to
  `fake`, so a development server started as before has the route.

Static tests pin who constructs what outside tests: the start service only
here; the start commit's repository only here and in its own package; the
route kit only here, in the development pipeline and in its own package.

## Decision 3 — The form

| Field | Shape |
| --- | --- |
| `organizationId` | an id: 1 to 64 letters, digits, `_` or `-`, which is what the app's ids are made of |
| `propertyId` | an id; it only says which pages to send the customer to |
| `qualityTier` | `NORMAL` or `HIGH_QUALITY`, as the offer showed it |
| `sceneId` | one per scene, in the order the offer listed them; at least one, each an id |
| `idempotencyKey` | 1 to 200 visible ASCII characters, made by the start page each time it shows an offer |

Shape only. Whether the scenes and quality are still the project's, and every
other rule, is the start service's. A double click, or a retry of a post whose
answer was lost, sends the same key and is the same start.

## Decision 4 — Where each answer sends the customer

| Answer | Lands on |
| --- | --- |
| `STARTED`, `ALREADY_STARTED` | the project page, `?started=1`: a replay lands where the start did |
| `VIDEO_EXISTS` | the start page: "This project already has a video, in progress or delivered. Nothing new was started." |
| `STORYBOARD_CHANGED`, `QUALITY_CHANGED` | the start page, saying what changed after the review, that nothing was started, and to review again |
| `QUALITY_NOT_OFFERED`, `LENGTH_NOT_SUPPORTED`, `NO_PLAN`, `INSUFFICIENT_UNITS` | the start page, saying why, and that nothing was started |
| `FORBIDDEN`, `NOT_FOUND` | the start page, saying nothing *new* was started: the service judges both before it reads the key, so a retry of a start that did happen, by a member who has since lost a permission or the project, is answered with them |
| `VALIDATION_FAILED` | the start page, saying nothing was started: the service judges it after the key |
| any other `AppError` | the start page: the start could not be confirmed, and trying again is safe, since a project's video is never started twice (ADR-0110). It may have failed after its write |
| anything else | not turned into a message: it is thrown |

The start page is the project's page plus `/start`; both paths are built only
from ids, and with `encodeURIComponent` besides, so a form cannot send the
customer anywhere but those two pages. The start page shows a fresh offer with a new key under the message
(GS-10d).

## Decision 5 — What stays out

- **The start page** and the project page's link to it are GS-10d. Until then
  nothing on the site posts to the route.
- **Progress.** A started job waits, reserved, until a person runs the
  development pipeline command (ADR-0108); the project page shows it from
  GS-11. Until the command runs, the job holds its project (ADR-0110) and its
  Units stay reserved. That is development only, with the test provider's
  Units; ADR-0052 Decision 19 (a reservation never pending indefinitely) is
  kept by the pipeline, which releases a failed video's Units, and in
  production by the scheduler whose activation stays BLOCKED.
- **Rate limiting** and a bound on the request's size. No route has them yet;
  rate limiting is one cross-cutting milestone in `docs/decisions/TODO.md`,
  which now names the start route among those it must cover.
- **No migration**, no new table, column or environment variable.

## Consequences

- In development with the test provider, a member holding `video.generate` and
  `unit.consume` can start a project's video with one form post; its Units are
  reserved and the job waits for the pipeline command.
- In production the route answers `404`, and no start is built.
- An HQ start is made in development because the test provider serves HQ; the
  production route table still offers Normal only.
- Activating a real provider means building the start from that provider's
  verified route policy, a decision the product owner makes separately.
