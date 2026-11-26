# ADR-0188 — The 404 page renders per request, so its scripts carry the nonce

Status: Accepted (PT-7c1, 2026-11-26). A milestone of production
readiness, part 2, approved by the product owner on 2026-11-26
(`docs/production-readiness-part2-gap-analysis.md`); the CTO chose
option B the same day. No customer surface, charge, business rule or
route changes: an unknown address still answers `404` with Next.js's
own page, whose scripts now run.

**Amends ADR-0174 Decision 10 (the page policy now holds on the 404
page too), ADR-0174 Decision 9 (a production build also sends the API
policy on `/_next/` and `/favicon.ico`) and ADR-0178's production-mode
spec (it asserts the 404's nonce instead of recording a count).**

## Context

The root layout (`apps/web/src/app/layout.tsx`) used no dynamic API and
there is no `app/not-found.tsx`, so `next build` prerendered
`/_not-found` to HTML at build time, and `next start` served that file
for every unknown address. A file written at build time has no
per-request nonce: Next.js reads the nonce from the request's policy
only when it renders. The middleware still sends the page policy with
a fresh nonce on that answer, so under `'strict-dynamic'` the browser
refused every script of the page. RD-9e measured it from `next start`
and RD-11b on a production build behind the TLS front: 11 scripts,
none carrying the nonce (`docs/production-readiness-completion.md`,
the lab list). The page showed Next.js's static text and could not
hydrate, and Chromium logged one refusal per script. Every one of the
17 pages already exports `dynamic = "force-dynamic"`; `/_not-found`
was the only static app route.

The plan's lab, a scratch Next.js 15.5.28 app with the real
middleware's matcher and a policy of the same shape, built with
`env -u NODE_ENV next build` and run with `next start`, measured four
variants on `/no-such-page`:

| Variant | `/_not-found` | Scripts, inline, nonced | Prerender files |
| --- | --- | --- | --- |
| A: as before | `○` (static) | 11, 6, 0; `x-nextjs-cache: HIT` | `_not-found.html`, `.rsc`, `.meta` |
| B: root layout `force-dynamic` | `ƒ` | 9, 4, 9 | none; manifest empty |
| C: `app/not-found.jsx` awaiting `connection()` | `ƒ` | 9, 4, 9 | none |
| D: `app/not-found.jsx` with `force-dynamic` | `ƒ` | 9, 4, 9 | none |

B keeps Next.js's own 404 markup (the same size in the route table,
`404` and the same `Cache-Control`); C and D replace it with a
component of ours.

## Decision 1 — The root layout is `force-dynamic` (option B)

`apps/web/src/app/layout.tsx` exports
`export const dynamic = "force-dynamic";` with a comment naming this
ADR. Next.js applies a layout's segment configuration to every route
under it, so `/_not-found` is rendered per request, reads the
middleware's nonce and puts it on each of its scripts. Next.js's own
404 markup and status stay, so nothing a customer sees changes but
that the page's scripts run. Route handlers do not render under the
layout, and every page already exported the line, so only
`/_not-found` changes.

## Decision 2 — The cost

Each 404 is now rendered per request instead of served from a file,
and no longer carries `x-nextjs-cache` or `x-nextjs-prerender`. A
render is a few milliseconds of server CPU (*inference*, not
measured), and bots probing unknown addresses now cause one each. It
is the same class of load as any page, and is left to part 2's edge
limit per client address (`TODO.md`, "Open in RD-8"); nothing is
limited here.

A page added later without its own `force-dynamic` now inherits it.
That is harmless: the nonce already requires every page to render per
request (ADR-0174 Decision 10).

## Decision 3 — What holds it

- **Unit:** `apps/web/src/app/layout-dynamic.test.ts` reads the layout
  with the TypeScript parser and requires exactly one exported `const`
  `dynamic` whose value is the literal `"force-dynamic"`. It fails if
  the line is removed, set to `"auto"`, left only in a comment, not
  exported, or written as a template.
- **The image, on every pull request:** CI's `web-image` probe asks
  `/no-such-page` and requires `404`, a nonce in the answer's policy,
  at least one `<script` tag and that nonce on every one.
  `tests/container-images.test.ts` pins its lines.
- **The image, in a browser:** the `production-mode` spec asks
  `/login` and `/no-such-page` outside the browser and requires the
  status, the production policy literal and the answer's nonce on
  every `<script` tag; then Chromium opens each under the violation
  guard (`tests/e2e/support/csp-guard.ts`), which fails on any refusal,
  and the spec polls until `next.version` is a string, as the e2e
  suite does under `next dev`, so Next.js's scripts ran. It replaces
  the `console.log` of the count. A tag regex alone would miss a
  script inserted after parse; the guard and the hydration check do
  not.

A future Next.js that prerendered `/_not-found` despite the layout
(*inference*: none is known) would fail both image holders.

## Decision 4 — The API policy on `/_next/` and the icon, production builds only

The middleware does not run for `/_next`, under `/_next/` or for
`/favicon.ico`, so an address there that names no file (`/_next`,
`/_next/nothing`, and
`/favicon.ico`, which the app does not have) was answered with
Next.js's 404 page and no policy at all. A production build's
`fixed-headers.mjs` now sends the existing `API_POLICY`
(`default-src 'none'; frame-ancestors 'none'; sandbox`) on
`/_next/:path*` and `/favicon.ico`; no new policy string is written.
Such a 404 then shows its text unstyled and its scripts are refused,
on addresses no customer opens.

- **Production builds only** (`nodeEnv === "production"`, the rule
  HSTS already follows): `next dev` serves its socket
  (`/_next/webpack-hmr`) and its development files there, and gets no
  new header, so the e2e suite runs as before.
- **A real file gets it too:** every chunk and stylesheet under
  `/_next/static`. A browser applies no policy to a script or style it
  loads as a subresource (*inference*; no worker is served from
  `/_next`), so pages still hydrate. The `production-mode` spec's
  hydration check on `/login` and `/no-such-page` holds that.
- **Still one policy per answer:** the middleware's matcher skips
  exactly these addresses, so configuration and middleware never both
  send one. Its term is `_next(?:/|$)`, as `/api`'s is `api(?:/|$)`,
  because `/_next/:path*` also matches the bare `/_next`. With a
  `_next/` term, as first written, both sent one there and only one
  reached the wire because Next.js set the middleware's over the
  configuration's (found in review). `middleware.test.ts` checks every
  page and non-page address, `/_next` and `/_next?x=1` included, under
  `production`, `development` and `test` against `next.config.mjs`'s
  rules and the matcher; `next-config.test.ts` pins the two rules,
  their value and their absence outside a production build. CI's
  `web-image` probe requires `/_next`, `/_next/nothing` and
  `/favicon.ico` to answer `404` with a policy equal to the API
  policy, which also proves one: fetch joins two headers of one name
  with a comma, and the policy has none.

The plan's lab (variant E, B plus these rules) measured exactly one
policy each on `/_next/nothing`, `/favicon.ico`, a real
`/_next/static/chunks/*.js` and `/no-such-page`.

## What was measured

On this tree, built with `env -u NODE_ENV pnpm exec next build` in
`apps/web` and run with `next start` under `NODE_ENV=production` and
the `web-image` job's sixteen stand-in settings, asked with `curl` on
`127.0.0.1`. Before (the line removed): `/_not-found` `○` in the route
table, and `/no-such-page` answered `404` with one policy,
`x-nextjs-cache` and `x-nextjs-prerender`, and 11 scripts, 6 inline,
0 carrying the nonce, as RD-11b counted. After: `ƒ` in the route
table, no app route `○`, an empty `prerender-manifest.json`, and
`/no-such-page` answered `404` with one policy, neither cache header,
and 9 scripts, 4 inline, 9 carrying the nonce. The `web-image` probe,
run on the same server, passed. The unit test failed with the line
removed and passed with it. With Decision 4 built, `/_next/nothing`,
`/favicon.ico` and `/_next/static/chunks/main-app-*.js` each answered
with exactly one policy, the API policy (`404`, `404`, `200`), where
the build without it sent none; `/login`, `/no-such-page` and
`/api/nothing` still answered with exactly one each. After the matcher
term became `_next(?:/|$)`, rebuilt and run the same way, `/_next` and
`/_next?x=1` answered `404` with exactly one policy, the API policy.
No browser ran locally; the browser holder's first run is the pull request's CI.

## Consequences and known gaps

- `style-src 'unsafe-inline'` stays, and the prerender was not why.
  The 404's markup is Next.js's error fallback
  (`http-access-fallback/error-fallback.js`); rendered per request, its
  `<style>` element and `style` attributes still carry no nonce
  (measured from `next start`). That fallback is why it stays
  (`TODO.md`).
- Turning on violation reports (PT-7c3) no longer means about 11
  reports for each visit to an unknown address.
- The Pages-router default `/500` is still prerendered:
  `next build` writes `.next/server/pages/500.html`, measured with 9
  `<script>` tags and none nonced. Next.js serves it for a `500` that
  reaches its `renderError` without an app result (read from
  `base-server.js`; not reproduced), and the middleware sends the page
  policy with a fresh nonce on that answer, so its scripts would be
  refused as the old 404's were. It predates this ADR (`TODO.md`).
- HSTS `includeSubDomains` and `preload` are not part of this ADR:
  they wait on the product owner's domain decision as PT-7c5, recorded
  under "Deviations from the approved plan" in
  `docs/production-readiness-part2-gap-analysis.md`.

## Considered and not done

**C and D, a `not-found.tsx` of our own:** each fixes the nonce, but
the page's wording becomes ours and so the product owner's; B changes
nothing visible. **Accept the gap:** the page cannot hydrate, and once
reports are on every visit would send about 11. **Drop
`'strict-dynamic'`:** the external chunks would then load under
`'self'`, but the 6 inline flight-data scripts would still be refused,
so the page still could not hydrate (*inference*: React needs
`self.__next_f`), and every page would accept any same-origin script.
**Hashes computed at build:** they change with every build and, under
`'strict-dynamic'`, do not cover the parser-inserted external chunks.
**For Decision 4, the same rules under `next dev`:** they would put a
policy on its socket and development files for no gain, since no
customer is served by `next dev`. **A fourth policy string** for those
addresses: the API policy already refuses everything and frames
nothing.
