# API Changes — RD-9e

Every page of the web app carries a Content Security Policy with a new
nonce per request, set by a new `apps/web/src/middleware.ts` (ADR-0174
Decision 10). **No migration, no dependency and no new setting.** RD-9
is complete with it.

## HTTP

Every page answer, and only a page answer, carries one
`Content-Security-Policy`. From a production build (`next build`, then
`next start`), and from anything but `next dev`:

```text
default-src 'self'; script-src 'self' 'nonce-N' 'strict-dynamic';
style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self';
font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none';
form-action 'self'; frame-src 'none'; frame-ancestors 'none'
```

From `next dev`, and so in the browser test, the same with
`'unsafe-eval'` added to `script-src` and `ws: wss:` to `connect-src`.
The header is one line, its directives joined by `; `.

`N` is 16 random bytes, base64, new for every request. Next.js 15.5.22
reads it from the request's policy and puts it on every script it
renders; the browser runs only those scripts and the ones they load.
The policy is enforced: no `Content-Security-Policy-Report-Only`, no
`report-uri` or `report-to`, no `upgrade-insecure-requests`.

| Path | Policy | Set by |
| --- | --- | --- |
| a page, `/` and below | the page policy above | the middleware |
| `/api` and `/api/...` | `default-src 'none'; frame-ancestors 'none'; sandbox` (RD-9d) | the configuration |
| `/_next/...`, `/favicon.ico` | none | — |
| Next.js's router prefetch (`Next-Router-Prefetch`) | none | — |
| a browser's document prefetch or prerender (`Purpose: prefetch`) | the page policy | the middleware |

The two sources never cover the same path: the middleware's matcher
leaves out exactly what the configuration's `/api/:path*` covers, and
the configuration sets no policy on `/:path*`, so no answer carries
two. A client-side navigation's payload (`RSC: 1`) is a page request
and gets the page policy; the document keeps the nonce it loaded with.
A policy a client sends on its own request is replaced, never read.
Next.js's router prefetch fetches a payload, not a document; a
browser's own prefetch or prerender of a page fetches the document it
may show, so it gets the page policy.

The middleware does not run under `/_next/` or for `/favicon.ico`,
which hold Next.js's files. But an address there that names no file is
answered with Next.js's not-found page, and from a production build
(measured with `next start`) `/favicon.ico`, which the app does not
have, and an unknown `/_next/<path>` outside `/_next/static` get that
prerendered HTML with no page policy at all; the fixed headers of RD-9d,
`X-Frame-Options: DENY` among them, still apply. A missing file under
`/_next/static` is answered in plain text.

What the pages load, measured over `apps/web/src`: only the app's own
scripts, one stylesheet, signed images and video at
`/api/storage/download` on the same origin, the MFA QR code as a
`data:` image, and `fetch` and `XMLHttpRequest` calls to `/api` on the
same origin. No `blob:`, font file, frame, worker or off-site address.

## Pages

No page changed. All 17 pages already export
`dynamic = "force-dynamic"`, so every one is rendered per request and
carries the nonce; none became dynamic in RD-9e. The production build
lists one static route, Next.js's own `/_not-found`, prerendered at
`next build`: from `next start` an unknown address gets that HTML with
the page policy, so its scripts are refused and its static text shows
(measured; recorded in `TODO.md`). `next dev` renders it per request,
with the nonce. Next.js's built-in fallback page renders an inline
`<style>` without a nonce, hence `'unsafe-inline'` styles in every
environment.

No page can be framed (`frame-ancestors 'none'`, besides RD-9d's
`X-Frame-Options: DENY`). A form may post, and be redirected, only to
this origin (`form-action 'self'`): a redirect built from `request.url`
that names the server's bind address becomes a refusal (`TODO.md`,
"Open in RD-9").

## Environment

None added. The policy branches on `NODE_ENV` as the middleware is
built: `development` under `next dev` only. The nonce needs nothing an
operator sets.

## Internal API

| Change | Where |
| --- | --- |
| New: the middleware, `config.matcher` | `apps/web/src/middleware.ts` |
| New: `newNonce()`, `pageContentSecurityPolicy(nonce, nodeEnv)`, `NONCE_BYTES`, `NONCE_PATTERN` | `apps/web/src/lib/security-headers.ts` |
| New: the browser test's `test` and `expect`, with the policy guard | `tests/e2e/support/csp-guard.ts` |

The middleware runs on the Edge runtime and imports only `next/server`
and `security-headers.ts`, which imports nothing. It sets the policy on
the request with `NextResponse.next({ request: { headers } })` and on
the answer. Where this differs from the RD-9 design, and why:

- **No `x-nonce` request header.** Next.js reads the nonce from the
  request's `Content-Security-Policy` (`app-render.js:108`), and no
  page or component reads a nonce: the app has no `next/script` and no
  inline script of its own.
- **The matcher leaves out all of `/_next/`**, not only
  `/_next/static` and `/_next/image`: Next.js's files are there, and no
  page of the app. An unknown address there is answered without a
  policy (above). And it leaves out `/api` exactly as the
  configuration's `/api/:path*` matches it, so `/apiary` would be a
  page.
- **Only Next.js's router prefetch is skipped.** The design's
  `Purpose: prefetch` skip is not built: browsers send that header when
  they prefetch or prerender a whole document (`<link rel=prefetch>`,
  speculation rules), which they may then show, and Next.js 15.5 never
  sends it.
- **A nonce that is not base64 is refused** by
  `pageContentSecurityPolicy`, so nothing else can reach the header.
- **Development is `NODE_ENV=development` exactly**; `test`, unset or
  anything else gets the production policy.
- **`next dev` needs nothing beyond `'unsafe-eval'` and `ws: wss:`**
  (critic U7, measured): every browser spec ran under the guard without
  a refusal. Without the two, Chromium refused `eval` on every page
  `next dev` served, so `'unsafe-eval'` is needed; it refused no socket,
  since its `'self'` matches the same host's `ws:`, and `ws: wss:` stay
  as the ADR says, for browsers that do not.

## Logs

None changed. A refused load is reported by the browser, not the
server.

## Tests and CI

New `apps/web/src/lib/security-headers.test.ts`: the production policy
exactly, for every `NODE_ENV` but `development`; the development policy
exactly, adding only `'unsafe-eval'` and `ws: wss:`; no inline or
`eval` scripts in production; `'unsafe-inline'` styles without a nonce;
no report endpoint, `upgrade-insecure-requests` or off-site source;
Next.js's own `getScriptNonceFromHeader` reads the nonce; a malformed
nonce refused; a nonce is 16 bytes in Next.js's pattern and new on each
of 1,000 calls.

New `apps/web/src/middleware.test.ts`: with Next.js's
`unstable_doesMiddlewareMatch`, the matcher runs for pages and
client-side navigations and a browser's document prefetch or
prerender, and not for `/api`, `/_next/...`, the icon or Next.js's
router prefetch; with `unstable_getResponseFromNextConfig` and the real
`next.config.mjs`, no path gets a policy from both; the middleware sets
one policy on the answer and the same on the request, with a new nonce
per call, replacing a client's own; `next dev`'s policy under
`development` only; it imports only `next/server` and the policy, which
imports nothing.

Every browser spec now takes `test` and `expect` from
`tests/e2e/support/csp-guard.ts`, which fails a test on a console
message naming the `Content Security Policy` or containing "Refused
to", or a `securitypolicyviolation` event on a page's window, in the
test's own browser and in any it opens with `browser.newPage` or
`browser.newContext`; a signed link's query is never printed. After the
test's last statement it lets each open page finish loading and answer
once, so what was already refused is reported. Its limit: a refusal
that comes later, from a script that runs after that or a page still
navigating as its context closes, is not seen; there is no fixed wait.
`tests/e2e/support/csp-guard.test.ts` checks that every spec under
`tests/e2e`, nested ones included, takes `test` from there and imports
only types from `@playwright/test`, in either quote style.

`tests/e2e/security-headers.spec.ts` now reads one policy on `/login`,
two loads of it and an unknown address: `next dev`'s policy, a new
nonce each time, that nonce on every `<script>` of the HTML, and
Next.js's client router started; and exactly one policy, the API's, on
`/api/health`. CI is unchanged: the e2e job runs the guard,
and the production build step compiles the middleware.
