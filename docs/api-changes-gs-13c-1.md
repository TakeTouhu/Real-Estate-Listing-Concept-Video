# API Changes — GS-13c-1

The start refuses a storyboard no route can make (ADR-0123). **No migration,
no new route or page and no environment variable.** The start route and page
exist only where the start is built (development with the test provider,
ADR-0111); in production nothing changes.

## HTTP

### Changed: `POST /api/video-projects/{projectId}/generations`

Two more reasons nothing was started, each a `303` to
`/properties/{propertyId}/video-projects/{projectId}/start?error=…`, checked
before any Unit is reserved:

| Outcome | Message |
| --- | --- |
| `SCENE_LENGTHS_NOT_SUPPORTED` | Some scenes are a length this video cannot be made at. Nothing was started. Compose the storyboard again. |
| `SETTINGS_NOT_SUPPORTED` | This video cannot be made with this project's settings yet. Nothing was started. |

Every other response is unchanged.

## Pages

### Changed: `GET /properties/{propertyId}/video-projects/{projectId}/start`

Two more offers that show no form:

- **Scenes of a length the video cannot be made at**: the lengths a scene may
  be ("5 to 15 seconds", or a list such as "5, 10 or 15 seconds"), each scene
  that is not (its number, room and length), and how to compose the storyboard
  again.
- **Settings no route can make**: "This video cannot be made with this
  project's settings yet."

## Internal API

### Added: `@app/domain`, route qualification

`qualifyingRoutes(facts, target, routes, models)`, moved unchanged out of
`JobLaunchPlanner`, and `judgeStartRoute(facts, routes, models)`, answering
`ONE_ROUTE`, `SCENE_LENGTHS` (the lengths the one route's model takes and the
scenes' indexes) or `NO_ROUTE`; types `RouteChoice`, `RouteQualificationFacts`
and `StartRouteVerdict`
(`packages/domain/src/job-launch/route-qualification.ts`).

### Changed: `@app/domain`, `GenerationStartService`

- A new dependency, `routes: StartRouteCheck`, built by
  `routeCheck(policy, models)` (`StartRouteFacts`, `StartRouteCheck`).
- `StartGenerationOutcome` adds `SCENE_LENGTHS_NOT_SUPPORTED` and
  `SETTINGS_NOT_SUPPORTED`.
- `StartOffer` adds `SCENE_LENGTHS_NOT_SUPPORTED` (with `durations` and each
  scene's `id`, `position` and `durationSeconds`) and `SETTINGS_NOT_SUPPORTED`.

### Changed: `@app/video-providers`, `FakeRouteKit`

Adds `routeCheck`, over the kit's own route policy and model catalog; the web
app's start is built with it.

### Changed: `apps/web`, the start view

`sceneLengths(durations)` words the lengths a scene may be; `refusal(offer)`
words `SETTINGS_NOT_SUPPORTED`.
