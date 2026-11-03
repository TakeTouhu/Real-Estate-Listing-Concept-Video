# ADR-0112 — The start page, shown only where the start is built

Status: Accepted (GS-10d, 2026-11-03). The fourth and last milestone of row
GS-10 of the generation-to-preview plan the product owner approved on
2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`: "the start
screen and its route"). Builds on ADR-0109 (the start offer), ADR-0110 (one
video of a project at a time) and ADR-0111 (the start route and the web app's
start, built only in development with the test provider).

## Context

The start route starts a project's video from a form post, and the start
service's offer says what that start would be. Nothing on the site shows the
offer or posts the form, so a customer still cannot start a video.

The plan's approval says the start screen and its route appear only in
development with the test provider, and are hidden or refused in production.
Paid Provider Activation, production Provider credentials, production paid AI
calls, the production scheduler and live Stripe charges stay BLOCKED
(ADR-0054 Decision 7).

## Decision 1 — The page: `/properties/{propertyId}/video-projects/{projectId}/start`

The page ADR-0111 Decision 4 sends refused starts to. In this order:

1. **Where the start is not built, the page is not found** (`notFound()`),
   before the session or anything else is read: the same
   `getGenerationStartService()` the route asks, so the page and the route
   are built in the same places.
2. **A signed-out visitor** is sent to sign in.
3. **The organization is found as on the project page**: the first of the
   member's organizations in which the Property in the URL is in reach.
4. **The start's own offer is asked**, as the signed-in member: its
   permissions first (`video.generate` and `unit.consume`), then its reach.
   A member without them is told they cannot start videos for this project,
   and the storyboard is not read. A project not found in this organization
   moves on to the member's next one.
5. **The project must be this Property's**, checked through the storyboard
   read the project page uses (`resolveStoryboardForProperty`); a project of
   another Property is not found. The same read gives each scene's room.
6. Where nothing matches, the page answers as the project page does: to the
   home page with "Property not found". Any other failure is thrown.

Viewing writes nothing: the offer reads the Unit period without opening it
(ADR-0109 Decision 3).

## Decision 2 — What it shows

For a `READY` offer:

- **The quality** by its customer name, Normal or HQ, and never a model or
  provider.
- **The scenes, in the offer's order**, each with its room and length, and the
  total length.
- **The Units it would reserve, and the forecast split**: "Starting now would
  reserve *n* HQ Units: *b* of your plan's Base Units and *a* additional HQ
  Units". The words say "would", and that the start reserves when the customer
  confirms, so the split can differ (ADR-0109 Decision 4).
- **What happens to them**: they are used only if the video is delivered; if
  none is, they come back (ADR-0052 Decision 19, ADR-0053).
- **What the video is**: made from the approved photos, carrying the notice
  that it was made with generative AI (Mode A, ADR-0071), not captured footage
  and no claim about dimensions, delivered to the organization only, nothing
  published (ADR-0052 Decision 2).
- **A line saying the page exists only in development**, and that the video is
  made when the development pipeline command runs (ADR-0108).

Every other offer says why the start would not happen now and what to do:

| Offer | The page says |
| --- | --- |
| `VIDEO_EXISTS` | the project's video is in progress, or has been delivered; a project has one video at a time and is started again only when its video ends without being delivered |
| `NOT_COMPOSED` | there is no storyboard yet: compose one on the project page |
| `STALE` | the approved photos changed: compose again on the project page |
| `RECOMPOSE` | the storyboard must be composed again before a video can be made from it |
| `QUALITY_NOT_OFFERED` | videos of its quality (Normal or HQ) cannot be made yet |
| `LENGTH_NOT_SUPPORTED` | the storyboard's length, longer than a video VTaVision makes |
| `NO_PLAN` | no plan yet, or not started; VTaVision sets it up when the contract starts |
| `INSUFFICIENT_UNITS` | the Units this video needs and how many the Units it may use cover; ask a member who manages billing about additional Units of its quality |

The `VIDEO_EXISTS` words follow the re-start rule in force (ADR-0110), the
recommended default while the product owner's answer is pending. The job is
never shown. As ADR-0109 Decision 4 requires, nothing more of the
organization's Units is shown than the start itself reveals.

A message the route sent back (`?error=`) is shown above the offer, as an
alert; the offer under it is read fresh.

## Decision 3 — The form

Only a `READY` offer has one, and it is the form ADR-0111 Decision 3 reads:
`organizationId`, `propertyId`, `qualityTier`, one `sceneId` per scene in the
offer's order, and `idempotencyKey`. Every field is hidden and every value is
the offer's or the page's own: the customer types nothing. It posts to
`/api/video-projects/{projectId}/generations`.

The key is made by the server each time the page is shown
(`crypto.randomUUID()`, 36 visible ASCII characters). A double click, or a
reload of the route's answer, sends the same key and is the same start;
starting again means reviewing again, as with a Unit purchase (ADR-0068).

## Decision 4 — The project page links to it

- **A "Review and start the video" link**, only where the start is built and
  the member's effective permissions hold both `video.generate` and
  `unit.consume`. It is shown whatever the storyboard's state: the start page
  says why a start would not happen.
- **A notice on the way back from a start** (`?started=1`, which the route
  sends): the video was started and its Units are reserved; they are used only
  if the video is delivered. Shown only where the start is built.

In production neither appears.

## Decision 5 — What stays out

- **Progress.** The notice repeats the route's answer; it does not read the
  job. The project page shows the video's progress from GS-11.
- **Preview and download** are GS-12.
- **A browser test of the page through the web app's composition** is GS-13.
  The root's database suites type-check without JSX, so they cannot render
  the page; the page's unit tests prove its reads, and that its form is what
  the route reads, and the route's database test proves that form starts the
  video.
- **Photos on the start page.** The rooms and lengths are listed; the photos
  are on the project page.
- **No migration**, no new table, column, route or environment variable. The
  page's words are English, like the rest of the site.

## Consequences

- In development with the test provider, a member holding `video.generate` and
  `unit.consume` can review a project's video and start it from the site.
- In production the start page is not found and the project page has no link
  to it.
- The re-start words change with the product owner's answer, if it differs
  from the default.
