# ADR-0174 — Every cookie-based change checks its origin; security headers and a Content Security Policy

Status: Accepted (RD-9a, 2026-11-25). The first part of the ninth
milestone of production readiness, part 1, which the product owner
approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`, design item
6 and PR-9). It decides all of RD-9, five pull requests in the order
RD-9a to RD-9e. RD-9a builds the comparison (Decisions 2 and 3), the
refusal log (Decision 5) and the guard test (Decision 6); every other
decision names the later RD-9 pull request that builds it, and nothing
here says it is built before then.

Builds on: ADR-0006 (the `SameSite=Lax` session cookie), ADR-0068 (the
origin check), ADR-0111 (the start route's 404 before its check),
ADR-0115 and ADR-0118 (the download route's own policy and `nosniff`),
ADR-0129 (`APP_BASE_URL`; the token pages' `strict-origin` referrer),
ADR-0150 Decision 2 and ADR-0151 (the ambient and the configured
`NODE_ENV`; a production start needs `APP_BASE_URL`). Amends ADR-0068
Decision 4 item 1, "the host the browser addressed" (Decision 2 here),
and Decision 5, "the origin check covers this route only" (Decision 1
here). ADR-0068 is not edited. If a later RD-9 measurement contradicts
a decision here, that PR writes a new ADR rather than editing this one.

## Context

`SecurityCompliance.md` asks for CSRF protection where cookie-based
changes are used, and for a CSP and secure headers. On `main` at
`b92f14d`, 45 route files under `apps/web/src/app` export a mutating
handler and 20 check `Origin`; the other 25 rely on `SameSite=Lax`
alone, which does not stop another origin of the same site. Among them
are sign-in, sign-up, the MFA routes and sign-out, which also revokes
the session on the server. The check compares `Origin`'s host with the
first `X-Forwarded-Host`, else `Host`: it ignores the scheme, and a
proxy that rewrites `Host` turns every form into a refusal. No security
header is sent app-wide; Next.js adds `X-Powered-By`. Five reports in
`/mnt/project-files/cto/rd-9/` read the routes, the origin, the headers
and the split, and checked each other; `decision.md` there records the
CTO's choices, all as the critic recommended (`critic.md` §2 to §5).

## Decision 1 — Every cookie-based change, with one named exception

Every exported `POST`, `PUT`, `PATCH` or `DELETE` under
`apps/web/src/app/api` that a session cookie can authorize checks its
origin: the 24 unchecked today, sign-in, sign-up, sign-out, the MFA
routes and the reset and verification routes included. Their pages post
from this site, so the check costs them nothing.

`PUT /api/storage/upload` is the one exception: its signed upload token
alone authorizes it, and it reads no cookie. Provider webhooks of part
2, which no browser sends, join the exceptions by their own ADR.
**Built in RD-9b** (the 11 signed-in work routes) **and RD-9c** (the 13
sign-in and account routes).

## Decision 2 — The expected origin is `APP_BASE_URL`'s

- **Set:** `Origin` must equal `new URL(APP_BASE_URL).origin` as a
  string: scheme, host and port. `Host` and `X-Forwarded-Host` are not
  read, so no proxy's handling of them matters, and an `http` page on
  the same host no longer passes.
- **Unset, in production:** every change is refused. Production is the
  ambient `NODE_ENV`, which a production build fixes, or the configured
  one; neither vouches for the other (ADR-0150 Decision 2). This closes
  the start with `NEXT_PHASE` naming the build, which the start check
  does not see (`TODO.md`, "Open in RD-2d").
- **Unset, elsewhere:** ADR-0068's host rule as before, for
  `next dev` without the setting and most route tests.
- **An environment that cannot be read** leaves the ambient `NODE_ENV`
  to decide, as the start check does (`checkWebStart`): a production
  build refuses, and a test run given no environment keeps the host
  rule, so `pnpm test` in a bare shell runs as before.

The check never reads `request.url`: behind a proxy it names the
server's bind address (Decision 12). No new setting: `APP_BASE_URL`
already exists, is validated as an origin, https in production, and is
required by a production start (ADR-0151). The comparison is a pure
function of the request and the setting (`originRefusal`);
`isSameOriginPost` reads the setting. **Built in RD-9a.**

## Decision 3 — No, opaque or malformed `Origin` is refused

As ADR-0068 Decision 4 already says. Every supported path sends one:
every change comes from a form or a `fetch` in a client component, no
server code or worker calls a route, and the browser test posts only
through Chromium.

`Sec-Fetch-Site` is not read. Against the exact origin, every request
it would refuse (`same-site`, `cross-site`, an `http` page) already
fails the `Origin` match; it could only add to the host rule, which
production never runs. **Built in RD-9a.**

## Decision 4 — First, and today's answer

The check is each handler's first statement, before the session, the
limiter and the body; only the start route's 404 outside development
comes first (ADR-0111). A refusal is today's `403 FORBIDDEN` envelope
through `appErrorToResponse`, each route with its own message, as the
20 checked routes answer now. Nothing is read, counted or audited for a
refused change. That is the reason for the order, not that a victim's
sign-in budget is safe: sign-in needs no cookie, so any non-browser
client may post a victim's address with any `Origin` and be counted;
the check stops visitors' browsers being used to carry the post.
**Built with each route, in RD-9b and RD-9c.**

## Decision 5 — Each refusal is logged by its reason

One `warn` per refusal, from the `same-origin` component:
`{ code: "ORIGIN_REFUSED", reason, route }`. The reasons:

| Reason | When |
| --- | --- |
| `NO_ORIGIN` | the request sends no `Origin` |
| `OPAQUE` | it sends `Origin: null` |
| `MISMATCH` | another origin, or one that is not an origin |
| `NO_HOST` | the host rule finds no `X-Forwarded-Host` or `Host` |
| `NO_SETTING` | production without `APP_BASE_URL` |

`route` is the call's own `METHOD /path`, given as the check's second
argument; each call RD-9b and RD-9c adds names its route. The 20 earlier
calls name none and are not edited for it: a shape test pins the Unit
purchase route's `isSameOriginPost(request)`. Their refusals log the
reason alone. The log never holds a header's value, an address or a
user. Refusals are not audited. It is the way to see a proxy or a
stripped `Origin` refusing real people, as RD-7c logs a missing client
address. **Built in RD-9a.**

## Decision 6 — One call per route, and a test that reads every route

No middleware and no wrapper for the check. Route tests call handlers
directly, so a middleware check is never run by them and fails open
where its matcher misses; a wrapper would hide the order a shape test
reads.

`tests/api/same-origin-coverage.test.ts` reads every `route.ts`, cuts
each mutating handler from its own `export` to the next, and requires
`isSameOriginPost(request` before that handler's first `await`. Cutting
per handler matters: `api/properties`'s `GET` awaits above its `POST`'s
check. A list names each handler not yet checked. The test fails for a
listed handler that is checked and for an unlisted one that is not, so
the list shrinks with each PR, to `PUT /api/storage/upload` alone by
RD-9c. A route the check names must be its own handler, and the test
pins the number of mutating handlers, 45, so a new route is seen.

The four MFA routes run through `mfaRoute`, which takes no request
today. In RD-9c it becomes `mfaRoute(request, handler, options)` and
checks first, keeping its `no-store`; the guard then counts
`mfaRoute(request` as the check. **Guard built in RD-9a**; `mfaRoute`
in RD-9c.

## Decision 7 — What the deployment must provide

`APP_BASE_URL` is the exact public origin customers open: `https`, the
custom domain, no port. Every other host name, the service's own
`run.app` address and `http` redirect to it at the front; reached
directly, every checked form and JSON change there is refused. A wrong
value fails closed and loudly: every checked form answers `403`,
sign-in too after RD-9c, and emailed links break as well. No new
setting. The product owner is told (critic §6, PO-1).

## Decision 8 — Fixed headers in `next.config.mjs`

On `/:path*`: `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`X-Frame-Options: DENY`, `Permissions-Policy` with camera, microphone,
geolocation, payment and usb off and `fullscreen=(self)` for the video
player, and `Cross-Origin-Opener-Policy` and
`Cross-Origin-Resource-Policy` `same-origin`.
`Strict-Transport-Security: max-age=31536000` in a production build
only, without `includeSubDomains` or `preload`. `poweredByHeader:
false`.

Two facts measured in Next.js 15.5.22 place them. A header set by the
configuration or by middleware is applied before the handler, and the
handler's header of the same name is dropped
(`send-response.js:46-52`, `router-server.js:328-331`). And
`headers()` is frozen at `next build` for `next start`
(`filesystem.js:254-273`). So `Cache-Control`, `Content-Disposition`
and a page CSP are never set there; a test forbids the first two and
`no-referrer`, and pins `fullscreen=(self)`. **Built in RD-9d.**

## Decision 9 — The API policy

`Content-Security-Policy: default-src 'none'; frame-ancestors 'none';
sandbox` on `/api/:path*`, in the configuration. It is a superset of
the download route's own policy (ADR-0115, ADR-0118), so winning over
it never weakens it, and that route's `401` and `404` gain it. The
route keeps its own header, which its tests read. **Built in RD-9d.**

## Decision 10 — The page policy

A new `apps/web/src/middleware.ts`, for pages only and skipping
prefetches, makes a 16-byte nonce and sets the policy on the request,
where Next.js reads the nonce (`app-render.js:108`), and on the answer:

```text
default-src 'self'; script-src 'self' 'nonce-N' 'strict-dynamic';
style-src 'self' 'unsafe-inline'; img-src 'self' data:;
media-src 'self'; font-src 'self'; connect-src 'self';
object-src 'none'; base-uri 'none'; form-action 'self';
frame-src 'none'; frame-ancestors 'none'
```

- **A nonce, not hashes or `'unsafe-inline'` scripts.** Next.js's
  inline data scripts differ per request, so no hash fits; and
  `'unsafe-inline'` would let any injected script run. Every page is
  already `force-dynamic`, so a nonce costs no static rendering.
- **`'unsafe-inline'` styles in every environment.** Next.js's own
  fallback page renders an inline `<style>` without a nonce
  (`error-fallback.js:24-25`), and in production the start page answers
  `notFound()` on every build until part 2 (`start/page.tsx:30-31`).
- **Development** adds `'unsafe-eval'`, `ws: wss:` and only what RD-9e
  measures `next dev` to need; never in the production string.
- **Enforced** from the start: no report-only, no `report-uri`, and no
  `upgrade-insecure-requests`, which RD-11's `http://localhost` run
  would trip on.

The middleware imports only `apps/web/src/lib/security-headers.ts`,
nothing from `@app/*`. Every browser spec fails on a CSP violation.
**Built in RD-9e.**

## Decision 11 — `Referrer-Policy` is never `no-referrer`

Not app-wide and not on any page: under it a browser sends
`Origin: null` on the page's own posts, which Decision 3 refuses. The
three token pages keep their `strict-origin` meta (ADR-0129).

## Decision 12 — Not done

- **`Sec-Fetch-Site`** (Decision 3). It is where the side-effecting
  `GET /api/assets/{id}/download-url` could be closed: that link counts
  and audits, and a `Lax` cookie rides another site's top-level link to
  it. It is not a change, so this check does not cover it (`TODO.md`).
- **A list of allowed origins**, or `Origin` and `Host` both matching,
  or `Host` normalized for case and port. One public origin; the host
  rule runs only outside production.
- **A CSP report endpoint**: a new unauthenticated `POST`.
- **HSTS `includeSubDomains` and `preload`**: the public domain is not
  chosen (PO-4).
- **CORS**: none is served, and no preflight is answered.
- **Redirects built from `request.url`** name the bind address behind a
  proxy; RD-10 or RD-11 is to measure and fix them (`TODO.md`, "Open in
  RD-9"). Under Decision 10's `form-action 'self'` the symptom becomes a
  CSP refusal.
- **Logging a failure the app does not know**: not RD-9's (`TODO.md`).

## What was measured

`same-origin.test.ts` accepts exactly `APP_BASE_URL`'s origin with any
host and refuses `http` for `https`, another port, a trailing slash, a
malformed origin and the addressed host, by reason; refuses in
production without the setting, by either `NODE_ENV`; keeps the host
rule where the environment cannot be read outside production; and logs
each refusal's reason and route, never a header's value.
`same-origin-coverage.test.ts` finds the check first in the 20 checked
handlers, `api/properties` included, and names the 25 others. The
invitation route tests post from the configured origin and now refuse
the host the request reached. A test failed for each change that undid
a part: the host accepted where the setting is set, `http` accepted for
`https`, no production refusal, a route dropped from the list, a check
after an `await` or only in a comment.

## Consequences

- After RD-9a, `APP_BASE_URL` must be the exact origin customers open,
  or every form on the 20 checked routes refuses; after RD-9c, every
  form and sign-in.
- The browser test is unaffected: `next dev` runs with `APP_BASE_URL`
  `http://localhost:3210`, the address Chromium opens.
- A shell that exports `APP_BASE_URL` makes three route test files
  refuse their own posts (`docs/local-setup.md`).
- RD-11 must prove the production policy in a browser, since the
  browser test runs `next dev`, and post a form through the image
  reached at a host name other than `localhost`.
- For the product owner, nothing to decide; told: PO-1 the exact
  address, PO-2 no framing by other sites, PO-3 any third-party script
  needs a reviewed policy change, PO-4 the domain choice also decides
  HSTS for subdomains, PO-5 a browser that sends no `Origin` cannot
  sign in after RD-9c.
