# ADR-0190 — Pages upgrade insecure requests; HSTS for subdomains waits for the domain

Status: Accepted (PT-7c4, 2026-11-26). A milestone of production
readiness, part 2, approved by the product owner on 2026-11-26
(`docs/production-readiness-part2-gap-analysis.md`); the CTO decided
`upgrade-insecure-requests` and the HSTS grammar the same day. No
customer surface, charge, business rule, route, setting or stored value
changes.

**Amends ADR-0174 Decision 10 (the production page policy gains one
directive) and writes down the rule for ADR-0174 Decision 12's "HSTS
`includeSubDomains` and `preload`", which stays not done. Changes the
approved plan's row PT-7c (Decision 5).**

## Context

After PT-7c3 (ADR-0189) every source in the page policy is `'self'`,
`'none'`, `data:` or the nonce, and it ends with
`report-uri /api/csp-report; report-to csp`. The app's links are
relative, production requires an `https` `APP_BASE_URL` (ADR-0151), and
the front redirects `http` (ADR-0174 Decision 7). A grep of
`apps/web/src` outside tests finds one absolute `http://` address,
`redirect.ts`'s `http://path.invalid`, a base `new URL` parses a path
against and that is never loaded or sent. Nothing a page loads today is
`http://`.

HSTS is `max-age=31536000` from `fixed-headers.mjs`, sent by production
builds only, for the app's own host, and frozen at `next build`. Which
public domain the app is served from is T2's (proposal, "public domain
and DNS"), and the product owner has not chosen it.

## Decision 1 — `upgrade-insecure-requests`, production policy only

`security-headers.ts` ends the production page policy, which every
`NODE_ENV` but `development` gets, with `upgrade-insecure-requests`, a
directive with no sources. A browser then asks an `http://` address a
page names over `https` instead: every subresource and form target, and
a link to the page's own host *(from the CSP specification, not
measured for links)*.

- It is defence in depth: for a future absolute `http://` reference,
  and for a first visit before the browser holds HSTS.
- `next dev`'s policy is unchanged. It serves plain `http`, where the
  upgrade would break its own files on any name but a loopback one.
- Nothing supported runs a production build over plain `http` in a
  browser: the `production-mode` job goes through the TLS front
  (ADR-0178 Decision 6), the `web-image` probe uses Node.js `fetch`,
  which applies no page policy, and e2e runs `next dev`.
- Measured with Chromium 153.0.8010.12 on a production build of this
  tree (`next start`, stand-in settings): over `http://localhost` and
  `http://127.0.0.1` the 5 static files stayed `http` and the page
  hydrated, so Chromium does not upgrade a loopback address. Over
  `http://app.pt7c4.test`, mapped to the same server, all 5 were asked
  over `https`, each failed (`ERR_CONNECTION_RESET`) and the page did
  not hydrate. `docs/local-setup.md` says so.

## Decision 2 — HSTS's grammar is pinned

`next-config.test.ts` reads `STRICT_TRANSPORT_SECURITY` from
`fixed-headers.mjs` and requires:

- `max-age` first, of at least 31536000 (one year), with no leading
  zero;
- at most `includeSubDomains`, as that literal token, and `preload`
  only beside it;
- no other token and none twice;
- the value sent only by a production build.

The grammar is tested on rejected samples too: `max-age=0`,
`max-age=300`, a year less one second, `preload` alone, a misspelled
`includeSubdomains`, a duplicate token, an unknown token. The value
today passes it, and so would PT-7c5's.

**`max-age=0` is refused.** It is the one value that withdraws HSTS in
an emergency. Sending it means editing this test, deliberately, in the
same change, and saying why there.

The older test that pins today's exact value, and no
`includeSubDomains` or `preload`, stays. PT-7c5 edits it.

## Decision 3 — The HSTS rule for PT-7c5

- **`includeSubDomains` is added when T2 names the public host:**
  - at once if the app is on a dedicated host such as `app.<domain>`,
    where it covers only names below that host;
  - if the app is on the apex, only with the product owner's yes that
    every subdomain of the domain serves `https`.
- **`preload` is never sent** without the product owner's explicit,
  domain-wide yes, and then only from the apex. The submission to the
  browsers' preload list is the product owner's act, not the app's.
  Leaving the list takes months *(inference, from hstspreload.org's
  published rules)*.
- **`max-age` stays one year** until then; longer is the CTO's call at
  PT-7c5.
- **Where it is sent** (the app, the load balancer, or both) is decided
  with PT-10, whose infrastructure code takes the domain as an input.
  The app's header stays as the floor; if both send it, PT-7c5 pins
  them equal.

## Decision 4 — Why nothing is built for HSTS now

`headers()` is frozen at `next build`, and the image gets no build
setting (ADR-0175 Decision 4). A value that depends on the domain
cannot become a setting without breaking that rule, and the middleware
reads no setting either. The domain cannot be guessed. So the value
stays as it is, and only the grammar it may move within is written.

## Decision 5 — The approved row PT-7c changes

The plan the product owner approved on 2026-11-26 lists PT-7c as
depending on T0 only, "each a CTO call". HSTS `includeSubDomains` and
`preload` bind the product owner's whole domain, so that part moved to
the product owner, after T2, as PT-7c5. The CTO's decision of the same
day carries it to the product owner; the part 2 gap analysis records
it under "Deviations from the approved plan" (since PT-7c1), and
PT-7c5 joins T2's "Unblocks" in the next owner summary.

**PT-7c counts as done only when PT-7c5 is done or explicitly
dropped.** PT-7c1 to PT-7c4 having merged makes it done in code, not
done.

The question for the product owner, with T2:

- Is the app on a dedicated host (`app.<domain>`) or on the apex?
- If on the apex: does every subdomain serve `https`? If the mail
  vendor's click or open tracking uses an `http`-only name under the
  apex, apex `includeSubDomains` would break the links in verification
  and password reset emails for anyone who has visited the apex.
- Do they want `preload`, knowing it binds the whole registrable domain
  and takes months to undo?

## What holds it

- **Unit:** `security-headers.test.ts` pins both policies exactly. The
  production one ends with `; upgrade-insecure-requests`, with no
  sources, for `production`, `test`, empty and unset; `development`'s
  has none; `sandbox` stays absent from both.
  `next-config.test.ts` holds Decision 2.
- **The image, in a browser:** the `production-mode` spec requires the
  new literal on `/login` and `/no-such-page`, and Chromium runs the
  whole sign-up-to-storage spec through the TLS front under the
  violation guard. It is the proof that nothing on the pages is
  upgraded into a failure.
- The `web-image` probe is unchanged.

## What was measured

On this tree, built with `env -u NODE_ENV pnpm exec next build` in
`apps/web` and run with `next start` under `NODE_ENV=production` and
sixteen stand-in settings like the `web-image` job's: `GET /login`
answered `200` with the policy ending
`report-uri /api/csp-report; report-to csp; upgrade-insecure-requests`,
`Reporting-Endpoints: csp="/api/csp-report"` and HSTS
`max-age=31536000`. Through a local TLS front (a Node.js `https` proxy
with a throwaway certificate for `localhost`), Chromium 153 opened
`/login` (`200`) and `/no-such-page` (`404`): each hydrated, its 5
static files came over `https` and none failed, and no
`securitypolicyviolation` event fired. The plain-`http` results are in
Decision 1. The `production-mode` spec was not run locally (no Docker
daemon here); CI's job is its first run.

## Considered and not done

**No, HSTS and `'self'` already cover it:** true for every page today,
but HSTS does not cover a first visit, and `'self'` lets through a
future absolute `http://` address on the app's own host.
**The directive under `next dev` too:** it would break `next dev` on
any non-loopback name, for no customer. **Allow `max-age=0` in the
grammar** (the critique's first option): the CTO chose that an
emergency withdrawal edit the test. **`includeSubDomains` now:**
harmless on a dedicated host, wrong on an apex whose subdomains are
unknown; the domain is not chosen.

## Consequences

- A production build served over plain `http` on a non-loopback name
  cannot load its own files in a browser. No supported path does that.
- A future third-party `http://` resource is upgraded, or fails, rather
  than loading as mixed content. That is intended.
- PT-7c5 waits on T2. Its row stays open in the completion report.
