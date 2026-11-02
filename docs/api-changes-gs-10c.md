# API Changes — GS-10c

The start route, built only where the test provider is (ADR-0111). **No
migration, no page and no environment variable.** In production the route
answers `404`, and no start is built.

## HTTP

### Added: `POST /api/video-projects/{projectId}/generations`

Starts the video a project's storyboard describes. A form post
(`application/x-www-form-urlencoded` or `multipart/form-data`) from the start
page, which GS-10d adds.

| Field | Shape |
| --- | --- |
| `organizationId` | an id: 1 to 64 letters, digits, `_` or `-` |
| `propertyId` | an id; only says where to send the customer |
| `qualityTier` | `NORMAL` or `HIGH_QUALITY` |
| `sceneId` | repeated, one per scene in the storyboard's order; at least one, each an id |
| `idempotencyKey` | 1 to 200 visible ASCII characters; the same key is the same start |

| Response | When |
| --- | --- |
| `404` `NOT_FOUND` (JSON envelope) | the start is not built here: production, or a provider other than `fake`. Nothing else is read. (A `GET` answers `405`: only `POST` is exported) |
| `403` `FORBIDDEN` (JSON envelope) | the `Origin` is missing or not this host |
| `303` to `/login` | signed out |
| `422` `VALIDATION_FAILED` (JSON envelope) | the body is not a form, or `propertyId` or the project id in the path is not an id |
| `303` to `/properties/{propertyId}/video-projects/{projectId}?started=1` | started, or this key already started it |
| `303` to `/properties/{propertyId}/video-projects/{projectId}/start?error=…` | nothing was started: an unreadable form, `VIDEO_EXISTS`, a changed storyboard or quality, a quality not offered, too long, no plan, Units short, refused permission or a project not found (nothing *new* was started), a storyboard that cannot be started; or the start could not be confirmed (trying again is safe) |
| `500` | an unexpected failure, not turned into a message |

The messages are listed in ADR-0111 Decision 4. The start page itself arrives
in GS-10d; until then nothing on the site posts here.

## Internal API

### Added: `apps/web`, `getGenerationStartService()` and `testProviderRoute(env)`

`getGenerationStartService(): GenerationStartService | null`, built once, only
where `createFakeRouteKit` accepts the environment; its qualities are the
kit's. `testProviderRoute(env)` returns the kit, or `null` where its guard
refuses it.

### Added: `apps/web`, the start form

`isId(value)`, `readGenerationStartForm(projectId, form)`, `readPropertyId(form)`,
`startPages(propertyId, projectId)`, `landingFor(outcome)` and
`failureMessage(error)` in `apps/web/src/lib/generation-start-form.ts`.
