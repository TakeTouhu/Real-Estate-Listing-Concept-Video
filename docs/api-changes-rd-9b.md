# API Changes — RD-9b

The 11 signed-in work routes check their origin first, as the 20 checked
routes already do (ADR-0174 Decisions 1 and 4). **No migration, no
dependency and no new setting.** 31 of the 45 mutating handlers now
check; RD-9c checks the 13 sign-in and account routes.

## HTTP

Each route below now refuses a post whose `Origin` is not this site's
(ADR-0174 Decision 2) with `403 FORBIDDEN` and the JSON error envelope,
before it reads the session, the limiter or the body. A post with no
`Origin`, `Origin: null` or a malformed one is refused the same way.

| Route | Refusal message |
| --- | --- |
| `POST /api/properties/{propertyId}/assets/upload-url` | A photo's upload must be started from this site |
| `POST /api/assets/{assetId}/complete` | A photo's upload must be completed from this site |
| `POST /api/assets/{assetId}/retry` | A photo's upload must be retried from this site |
| `POST /api/properties/{propertyId}/assets/{assetId}/analysis` | A photo must be analyzed from this site |
| `POST .../analysis/refresh` | A photo's analysis must be refreshed from this site |
| `POST .../analysis/approve` | A photo's analysis must be approved from this site |
| `POST .../analysis/reject` | A photo's analysis must be rejected from this site |
| `POST .../analysis/correction` | A photo's analysis must be corrected from this site |
| `POST /api/properties/{propertyId}/video-projects` | A video project must be created from this site |
| `POST /api/video-projects/{projectId}/storyboard` | A storyboard must be composed from this site |
| `POST /api/organizations/{organizationId}/mfa-requirement` | The MFA requirement must be changed from this site |

A refused post is not counted by the upload or analysis limit, and
nothing is read, written or audited for it. The MFA requirement route
is a form route that answers its other outcomes with a `303`; its
refusal is the JSON `403`, as for the checked form routes (ADR-0068
Decision 4). Every other answer of these routes is unchanged.

## Pages

None changed. The upload, review, video-project and storyboard panels
call these routes with a same-origin `fetch`, and the dashboard posts
the MFA requirement form; the browser sends `Origin` on each.

## Environment

None added.

## Internal API

None changed. Each new call names its route, as `isSameOriginPost(request,
"POST /api/assets/[assetId]/retry")`.

## Logs

A refusal on these routes logs `warn` `ORIGIN_REFUSED` with its reason
and its `route` (ADR-0174 Decision 5). No header value, address or user.

## Tests and CI

`same-origin-coverage.test.ts` lists 14 handlers: the 13 for RD-9c and
`PUT /api/storage/upload`. The `analysis-`, `review-`,
`property-reach-`, `content-reach-`, `storyboard-` and
`organization-mfa-requirement-routes` tests post from the host they
reach, and each checked route is refused, signed in or not, for no
`Origin` and for another site, with its body unread, no limit counted
and nothing written or audited. The browser test is unchanged. CI is
unchanged.
