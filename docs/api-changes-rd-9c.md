# API Changes — RD-9c

The 13 sign-in and account routes check their origin first, as the 31
checked routes already do (ADR-0174 Decisions 1, 4 and 6). **No
migration, no dependency and no new setting.** 44 of the 45 mutating
handlers now check; `PUT /api/storage/upload`, authorized by its signed
token alone, is the one exception.

## HTTP

Each route below now refuses a post whose `Origin` is not this site's
(ADR-0174 Decision 2) with `403 FORBIDDEN` and the JSON error envelope,
before it reads the session cookie, the limiter or the body. A post
with no `Origin`, `Origin: null` or a malformed one is refused the same
way.

| Route | Refusal message |
| --- | --- |
| `POST /api/auth/login` | A sign-in must be started from this site |
| `POST /api/auth/mfa` | A sign-in code must be entered from this site |
| `POST /api/auth/register` | An account must be created from this site |
| `POST /api/auth/logout` | A session must be ended from this site |
| `POST /api/auth/reset-password/request` | A password reset link must be asked for from this site |
| `POST /api/auth/reset-password` | A new password must be chosen from this site |
| `POST /api/auth/verify-email` | An email address must be verified from this site |
| `POST /api/auth/verify-email/resend` | A verification link must be asked for from this site |
| `POST /api/organizations` | An organization must be created from this site |
| `POST /api/mfa/setup` | MFA must be changed from this site |
| `POST /api/mfa/setup/confirm` | MFA must be changed from this site |
| `POST /api/mfa/recovery-codes` | MFA must be changed from this site |
| `POST /api/mfa/disable` | MFA must be changed from this site |

A refused post is not counted by the sign-in, MFA code, sign-up, reset
or verification email limit, so a page on another site cannot use a
visitor's browser to spend them. Nothing is read, sent, written or
audited for it: a refused sign-out leaves the session and its cookie
in place, and a refused sign-in or sign-up sets no cookie. The MFA
routes' refusal keeps `Cache-Control: no-store`. The form routes answer
their other outcomes with a `303`; their refusal is the JSON `403`, as
for the checked form routes (ADR-0068 Decision 4). Every other answer
of these routes is unchanged.

## Pages

None changed. The sign-in, code, sign-up, verify, reset and dashboard
pages post these forms, and the security page calls the MFA routes
with a same-origin `fetch`; the browser sends `Origin` on each. The
three token pages keep `referrer: "strict-origin"`, which keeps it a
real origin.

## Environment

None added. `APP_BASE_URL` must be exactly the address customers open,
or sign-in is refused (`docs/migration-notes.md`, RD-9c).

## Internal API

`mfaRoute(request, route, handler, options)` takes the request and its
route's `METHOD /path` and checks the origin before the sign-in, the
handler or the body; `POST /api/mfa/setup` and
`POST /api/mfa/recovery-codes` now take their request. Every other new
call names its route, as `isSameOriginPost(request,
"POST /api/auth/login")`.

ADR-0174 Decision 6 names this helper `mfaRoute(request, handler,
options)`; RD-9c adds `route` as its second argument because Decision 5
asks each call RD-9c adds to name its `METHOD /path` in the refusal
log, and the coverage test checks that literal against the route's own
file. The rest of Decision 6 holds: the helper takes the request,
checks before its first `await`, keeps `no-store`, and the guard counts
`mfaRoute(request` as the check. The four MFA routes share one refusal
message, as they share one subject, the way the grant and revoke
permission pairs already share theirs.

## Logs

A refusal on these routes logs `warn` `ORIGIN_REFUSED` with its reason
and its `route` (ADR-0174 Decision 5). No header value, address or user.

## Tests and CI

`same-origin-coverage.test.ts` lists one handler, `PUT
/api/storage/upload`, with its permanent reason. It counts
`mfaRoute(request` before a handler's first `await` as the check, and
reads `mfaRoute` itself, which must check before its own first `await`.
The `mfa-`, `email-verification-` and `password-reset-routes` tests,
and the organization MFA requirement test's sign-in, post from the
site's origin, and each route is refused, signed in or not, for no
`Origin` and for another site, with its body unread, no limit counted
and nothing sent, written or audited. The new `logout-route.test.ts`
proves that sign-out ends the session on the server and clears its
cookie, and that a refused one does neither. The browser test is
unchanged. CI is unchanged.
