# API Changes — GS-10d

The start page, shown only where the start is built (ADR-0112). **No new
route, no migration and no environment variable.** In production the page is
not found and the project page has no link to it.

## HTTP

No API route is added or changed. The start route (`POST
/api/video-projects/{projectId}/generations`, GS-10c) now has a page that
posts to it.

## Pages

### Added: `GET /properties/{propertyId}/video-projects/{projectId}/start`

| Response | When |
| --- | --- |
| `404` | the start is not built here: production, or a provider other than `fake`. Nothing else is read |
| redirect to `/login` | signed out |
| redirect to `/?error=Property not found` | the Property is out of the member's reach, the project is not found in an organization that reaches it, or the project is another Property's |
| the page, saying the member cannot start videos | the member lacks `video.generate` or `unit.consume`; no form |
| the page, saying why not | an offer other than `READY` (ADR-0112 Decision 2); no form |
| the page, with the offer and the start form | a `READY` offer |

`?error=` shows the start route's message above the offer. The form posts the
fields ADR-0111 Decision 3 names, every one hidden, with a key made for this
showing of the page.

### Changed: `GET /properties/{propertyId}/video-projects/{projectId}`

- A "Review and start the video" link to the start page, only where the start
  is built and the member holds `video.generate` and `unit.consume`.
- `?started=1`, which the start route sends after a start or a replay of one,
  shows that the start was confirmed and that a started video's Units are used
  only if it is delivered, only where the start is built.

## Internal API

### Added: `apps/web`, `StartView` and `refusal(offer)`

In `apps/web/src/app/properties/[propertyId]/video-projects/[projectId]/start/start-view.tsx`:
the start page's body for an offer, and the words for each offer that cannot
be started.

### Changed: `apps/web`, `StoryboardView`

Two new properties: `startHref` (the start page, or `null`) and `started`.

### Added: `apps/web`, `startOnProjectPage(built, permissions, propertyId, projectId, started)`

In `apps/web/src/lib/generation-start-form.ts`: the project page's link and
notice, from whether the start is built, the member's effective permissions
and the `started` query parameter.
