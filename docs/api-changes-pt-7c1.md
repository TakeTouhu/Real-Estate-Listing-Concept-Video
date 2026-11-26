# API Changes — PT-7c1

The 404 page renders per request, so its scripts carry the nonce
(ADR-0188). Production readiness, part 2, approved by the product
owner on 2026-11-26. **No route, stored value, setting, image or
migration changes.** What changes is how a production build answers an
unknown address, the policy on `/_next/` and the icon, and the checks
that hold them.

## Before and after

Before, `next build` prerendered `/_not-found`, and `next start`
served that file for every unknown address:

```text
GET /no-such-page  ->  404, the page policy with a fresh nonce,
                       x-nextjs-cache: HIT, x-nextjs-prerender,
                       11 <script> tags, 6 inline, 0 with the nonce
```

so the browser refused all 11 and the page could not hydrate. After,
the root layout exports `dynamic = "force-dynamic"`, the route table
shows `ƒ /_not-found` and no static route, and the same request
answers:

```text
GET /no-such-page  ->  404, the page policy with a fresh nonce,
                       no x-nextjs-cache, no x-nextjs-prerender,
                       9 <script> tags, 4 inline, 9 with the nonce
```

(measured from `next start` on this tree; ADR-0188, "What was
measured"). The markup is still Next.js's own 404 page; nothing a
customer reads changes. `next dev` already rendered the 404 per
request and is unchanged.

## `/_next/` and the icon (ADR-0188 Decision 4)

A production build now sends the API policy (`default-src 'none';
frame-ancestors 'none'; sandbox`) on `/_next/:path*` and
`/favicon.ico`, where the middleware does not run:

```text
GET /_next/nothing               ->  404, the API policy, once
GET /favicon.ico                 ->  404, the API policy, once
GET /_next/static/chunks/<file>  ->  200, the API policy, once
```

Before, each answered with no policy. A browser applies no policy to a
script or stylesheet it loads, so pages are unchanged. `next dev`
sends none there, so its socket and development files are untouched.

## Checks

- CI's `web-image` probe requires, of `/no-such-page`: `404`, a nonce
  in its policy, at least one `<script` tag and that nonce on every
  one.
- The `production-mode` spec requires the same of `/login` and
  `/no-such-page` with the full production policy, then opens both in
  Chromium under the violation guard and waits for `next.version`.
  The count it used to print is gone.
- `apps/web/src/app/layout-dynamic.test.ts` requires the layout's
  export, read with the TypeScript parser.
- The `web-image` probe also requires `/_next/nothing` and
  `/favicon.ico` to answer `404` with a policy equal to the API policy;
  `next-config.test.ts` and `middleware.test.ts` hold the rules and
  that no address gets two policies.

## Who is affected

A visitor to an unknown address: the page's scripts now run, and the
browser logs no refusal. The server: each 404 now costs a render
(ADR-0188 Decision 2).

## Phase documentation

- Change log and release notes: this document and the Roadmap's PT-7c1
  paragraph, as for PT-7b1 to PT-7b3.
- Architecture: `docs/architecture.md`'s security-headers row.
  Sequence and entity-relationship diagrams: Not applicable; no flow
  or table changes.
- OpenAPI: Not applicable; no route or answer body changes.
- Database migration: Not applicable; see `docs/migration-notes.md`.
