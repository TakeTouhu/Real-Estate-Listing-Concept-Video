# API Changes — Next.js 15.5.28

`next` goes from 15.5.22 to 15.5.28, a patch release, and the web app
turns Next.js's image optimizer off (`images: { unoptimized: true }` in
`apps/web/next.config.mjs`). Added to part 1 by the CTO after RD-10a,
before RD-11 (critic C14). **No migration and no new setting**, and the
app uses no `next/image`. Every answer but `/_next/image`'s is as
before: the download route still sends its `Content-Length` (ADR-0115
Decision 3).

## Why

`pnpm audit --prod` on 2026-11-25 found nine advisories in `next`
15.5.22: three critical (remote code execution, two of them in the
image optimizer at `/_next/image`), one high (denial of service in the
App Router through Server Actions) and five moderate. 15.5.28 fixes six
of them: the three critical (fixed from 15.5.24 and 15.5.28), the high
one (from 15.5.28) and the two cache-poisoning moderates (from
15.5.27). The image optimizer is an endpoint every Next.js server
answers, whether or not a page uses it; the app does not, so it is
turned off rather than left patched and reachable.

| `pnpm audit --prod` | Critical | High | Moderate | Total |
| --- | --- | --- | --- | --- |
| before (15.5.22) | 3 | 12 | 7 | 22 |
| after (15.5.28) | 0 | 11 | 5 | 16 |

Still open:

- `next` 15.5.28: three moderate advisories fixed only in 15.5.29.
  None of them applies to this app; see the next section.
- `sharp` 0.33.5 and the 0.34.5 that `next` takes as optional: three
  high advisories, counted once per version, so six. Fixed from 0.35.5.
- `zod` 3.25.76: one high. Fixed in 4.6.6, a major version.
- `postcss` 8.4.31, which `next` 15.5.28 pins exactly: two high, two
  moderate. Fixed from 8.5.23.
- `postcss`'s `nanoid` 3.3.16 and `source-map-js` 1.2.1: one high each.

`sharp`, `zod` and `postcss` need more than a patch bump. `nanoid` and
`source-map-js` do not: their fixes, 3.3.18 and 1.2.2, are patch
releases inside the ranges `postcss` asks for (`^3.3.6`, `^1.0.2`), so
a lockfile refresh would fix them without touching `next`. This change
installs nothing but `next`, so it leaves them. All stay in `TODO.md`,
"Open in RD-10".

## Why 15.5.28 and not 15.5.29

15.5.29 drops the `Content-Length` a route handler sets. Its
`dist/server/send-response.js` adds a `FORBIDDEN_HEADERS` list (`:18-22`:
`content-length`, `content-encoding`, `transfer-encoding`) and skips a
handler's header of those names (`:49-51`). 15.5.27's and 15.5.28's
files have no such list (69 lines each, against 81), and 15.5.28's is
byte for byte 15.5.22's (`diff` exit 0). The download route sets
`Content-Length` (`apps/web/src/app/api/storage/download/route.ts:63`),
and ADR-0115 Decision 3 says it is the bytes sent.

Measured, a `Response` carrying `Content-Length: 5` passed to each
version's `sendResponse` by a plain Node.js server:

| `next` | `GET`, `200` | `HEAD`, `200` |
| --- | --- | --- |
| 15.5.22 | `Content-Length: 5` | `Content-Length: 5` |
| 15.5.28 | `Content-Length: 5` | `Content-Length: 5` |
| 15.5.29 | chunked, no length | no length |

On `next dev` 15.5.28, the real download route served a 1000-byte
object from a shared folder through a signed token: `GET` `200` with
`Content-Length: 1000`; `Range: bytes=100-199` `206` with
`Content-Length: 100` and `Content-Range: bytes 100-199/1000`; `HEAD`
`200` with `Content-Length: 1000`; none of them chunked.

The three advisories fixed only in 15.5.29 do not apply:

- **GHSA-7qx7-33qx-rqx2, an SVG rejection bypass in the image
  optimizer.** The optimizer is off (`next.config.mjs:12`), so
  `/_next/image` answers `404` before it reads the query
  (`next-server.js:255-257`; see "HTTP"). No file under `apps/web/src`
  imports `next/image`.
- **GHSA-f3mh-rxg3-f5g2, an `HttpOnly` cookie copied into an internal
  answer header on Edge runtime routes.** No route declares
  `runtime = "edge"` (`grep` over `apps/web/src`: none), so every route
  handler runs on Node.js, the six that set or delete cookies among
  them (sign-in, the second sign-in step, sign-out, registration,
  accepting an invitation and setting one aside).
  The middleware runs on the Edge runtime but sets no cookie: it sets
  only `content-security-policy`, on the request and on the answer
  (`apps/web/src/middleware.ts:20-27`).
- **GHSA-pc58-hwjq-p385, response injection in apps that forward a
  fetched response.** No route handler returns a fetched `Response` or
  copies its headers. The download route builds its own headers from
  the stored object's size (`route.ts:60-71`). The bytes it streams
  are read as stored, with `accept-encoding: identity` and
  `compress: false`, and held to exactly that length; a shorter or
  longer answer errors (`google-cloud-storage.ts:647-659` and
  `answerStream`, in `packages/storage/src/google-cloud-storage/`).
  The server code under `apps/web/src` calls no `fetch`: the seven
  files that do are `"use client"` components. Nothing asks for the
  fetch cache (`force-cache`, `revalidate`, `unstable_cache`: none).

A move to 15.5.29 or later first decides how downloads keep their
length; `TODO.md` says so.

## Dependencies

`apps/web/package.json`: `"next": "15.5.28"`. In `pnpm-lock.yaml` only
`next` and the packages of the same release change: `@next/env` and the
eight `@next/swc-*` binaries (one installed per platform), each
15.5.22 → 15.5.28. Every other package `next` pulls (`@swc/helpers`,
`caniuse-lite`, `postcss`, `styled-jsx`, its optional `sharp`) keeps its
version.
`pnpm install` reported `+3 -3`.

## HTTP

`/_next/image` no longer optimizes anything. Measured with the
standalone server of a production build (`env -u NODE_ENV pnpm run
build`, then `apps/web/.next/standalone/apps/web/server.js`):

| Request | 15.5.28, optimizer on | 15.5.28, `unoptimized: true` |
| --- | --- | --- |
| `GET /_next/image?url=%2Ffavicon.ico&w=64&q=75` | `400` "The requested resource isn't a valid image." | `404` |
| the same with `url=%2Fnope.png` | `400` | `404` |
| the same with an off-site `url` | `400` | `404` |
| `GET /_next/image` with no query | `400` | `404` |

With the optimizer on, the favicon and `/nope.png` requests got their
`400` after the server had fetched the URL from itself and inspected
the bytes (`image-optimizer.js:1016-1018`). The parameter check refused
the off-site and no-query requests before any fetch.

With the optimizer off, the server matches the path by its
`/_next/image` prefix (`next-server.js:228`), loads the optimizer's
module and checks its cache (`:241-253`), and then answers the `404`
(`:255-257`, `render404`). It does this before validating or fetching
the query: `validateParams` comes after, at `:259`. The `404` is Next.js's
prerendered not-found page, with RD-9d's fixed headers and no page
policy, as every unknown `/_next/` address outside `/_next/static`
already gets (RD-9e): the middleware does not run under `/_next/`.

What RD-10a's smoke already checks still holds on 15.5.28:
`/api/health` answers `200` with
`Strict-Transport-Security: max-age=31536000` and no `X-Powered-By`;
`/login` answers `200` with a page policy carrying a nonce, and all 10
of its `<script>` tags carry that nonce; readiness without the token
answers `401`. These were measured on 15.5.28 only; the 15.5.22
baseline is RD-10a's CI smoke.

## What the code comments cite

Two Next.js facts the code relies on were read again in the 15.5.28
source, and both still hold:

- **Next.js reads the nonce from the request's policy**
  (`apps/web/src/lib/security-headers.ts`):
  `server/app-render/app-render.js:108-109` reads
  `content-security-policy` from the request and passes it to
  `getScriptNonceFromHeader`; lines 95-125 and
  `get-script-nonce-from-header.js` are byte for byte 15.5.22's. The
  cited line stays `app-render.js:108`.
- **A header the configuration sets drops a route handler's header of
  the same name** (`apps/web/fixed-headers.mjs`):
  `server/send-response.js:46-52` appends a handler's header only when
  none of that name is present, `Set-Cookie`, `WWW-Authenticate`,
  `Proxy-Authenticate` and `Vary` aside. The file is 15.5.22's, so the
  cited lines stay `:46-52`.

Both comments now name 15.5.28. Historical records that name 15.5.22
stay as they are. No unit test pins the version:
`security-headers.test.ts` calls the installed `getScriptNonceFromHeader`.

## Environment

None added or changed.

## Internal API

| Change | Where |
| --- | --- |
| `images: { unoptimized: true }` | `apps/web/next.config.mjs` |
| Version cited in a comment | `apps/web/src/lib/security-headers.ts`, `apps/web/fixed-headers.mjs` |

## Tests and CI

The `web-image` job's smoke probe adds one check: `GET
/_next/image?url=%2Ffavicon.ico&w=64&q=75` answers `404`; the
optimizer-on build above answered that request `400`, and the probe
failed against it. The probe runs no new Docker command.

Two tests pin the change. `apps/web/src/next-config.test.ts` checks
that `images.unoptimized` is `true`. `tests/container-images.test.ts`
checks the `images: { unoptimized: true },` line and the web-image
job's two `/_next/image` probe lines. Deleting either line fails them.
The browser tests ran on `next dev` 15.5.28 under the policy guard on a
fresh database: 13 passed.
