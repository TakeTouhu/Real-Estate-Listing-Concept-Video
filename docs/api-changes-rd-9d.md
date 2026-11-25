# API Changes — RD-9d

Every answer of the web app carries fixed security headers, and every
`/api` answer a restrictive policy, set in `apps/web/next.config.mjs`
(ADR-0174 Decisions 8, 9 and 11). **No migration, no dependency and no
new setting.** RD-9e adds the page policy.

## HTTP

On every path, in every environment:

| Header | Value |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |

From a build made under `NODE_ENV=production` only (`next build`,
then `next start`), on every path: `Strict-Transport-Security:
max-age=31536000`, without `includeSubDomains` or `preload`. `next
dev`, and so the browser test, never sends it.

On `/api/:path*` only: `Content-Security-Policy: default-src 'none';
frame-ancestors 'none'; sandbox`. No page carries it.

`X-Powered-By: Next.js` is no longer sent.

A header set by the configuration replaces a route handler's of the
same name (Next.js 15.5.22). The configuration names none that a
handler decides per answer: `Cache-Control`, `Content-Disposition`,
`Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`,
`Location`, `Retry-After` and `Set-Cookie` stay the handler's. Two names
are shared, both with the download route:

| Route | Its own | What the browser gets |
| --- | --- | --- |
| `GET`/`HEAD /api/storage/download`, `200`/`206`/`416` | `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff` | the API policy, which contains the route's, and the same `nosniff` |
| same route, `401`/`404` | neither | the API policy and `nosniff`, new |

## Pages

No page changed. Each page answer gains the fixed headers. The three
token pages keep their `strict-origin` referrer meta, stricter than the
header. No page can be framed by another site, or by this one.

## Environment

None added. HSTS follows the `NODE_ENV` in effect when `next build`
runs. `next build` sets it to `production` only when it is unset; a
build run with another `NODE_ENV` sends no HSTS, so the production
image must be built with `NODE_ENV` unset or `production` (RD-10 builds
the images). `headers()` is frozen at build time, so nothing an
operator sets at run time changes these headers.

## Internal API

| Change | Where |
| --- | --- |
| New: `EVERY_ANSWER_HEADERS`, `API_POLICY`, `STRICT_TRANSPORT_SECURITY`, `fixedHeaderRules(nodeEnv)` | `apps/web/fixed-headers.mjs` |
| `headers()` returns `fixedHeaderRules(process.env.NODE_ENV)`; `poweredByHeader: false` | `apps/web/next.config.mjs` |

## Logs

None changed.

## Tests and CI

New `apps/web/src/next-config.test.ts`: the configuration sends no
`X-Powered-By`; the fixed headers on `/:path*` and the API policy on
`/api/:path*` under `production`, `development` and `test`; HSTS under
`production` only, never with subdomains or preload; no rule names a
header a handler decides, or `no-referrer`; `fullscreen=(self)`; and the
download route's own policy is contained in the API policy. New
`tests/e2e/security-headers.spec.ts` reads the headers of `/login`,
`/api/health`, a signed download link and a refused one from `next
dev`: the fixed set, no HSTS, no `X-Powered-By`, the API policy on the
API only, and the download route's own `Cache-Control`,
`Content-Disposition` and `Content-Type` kept. CI is unchanged.
