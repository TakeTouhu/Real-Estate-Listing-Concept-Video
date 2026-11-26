# API Changes — PT-7c3

The page policy reports to the endpoint (ADR-0189, "Built in PT-7c3").
Production readiness, part 2. **No route, stored value, setting, image
or migration changes.** What changes is the page policy, one response
header on pages, one category in the report line, and the checks that
hold them. No new ADR: the relative endpoint was measured to work.

## The page policy, before and after

Production, before (PT-7c2), with `{n}` the request's nonce:

```text
default-src 'self'; script-src 'self' 'nonce-{n}' 'strict-dynamic';
style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self';
font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none';
form-action 'self'; frame-src 'none'; frame-ancestors 'none'
```

After, the same with two directives at the end:

```text
...; frame-ancestors 'none'; report-uri /api/csp-report; report-to csp
```

`next dev`'s policy gains the same two. `upgrade-insecure-requests`
and `sandbox` are still absent (PT-7c4).

**The API policy is unchanged** and reports to nothing:
`default-src 'none'; frame-ancestors 'none'; sandbox`. An unknown
`/api/<path>` answers Next.js's HTML 404 under that policy, so a
report directive there would report on every such visit: its inline
styles and loads, not its scripts, which `sandbox` blocks first
*(inference: no report came for one)*. Measured with Chromium
153.0.8010.12 on a scratch page under that policy with `report-uri`,
an inline `<style>`, an image and an inline script: the style and the
image were reported, the script was not, and each report came with
`Origin: null`, from the opaque origin `sandbox` gives, but named the
visited `/api` address as its document, which the endpoint would
accept and count as page `(other)`.

## The new header

Every page answer the middleware handles carries:

```text
Reporting-Endpoints: csp="/api/csp-report"
```

The middleware sets it beside the policy, on the answer only, never
on the request the page renders from. It does not run for `/api`,
`/_next`, `/favicon.ico` or Next.js's router prefetch, so those get
none, as they get no page policy. The group is `csp`, never `default`,
which other kinds of report use *(inference from the Reporting API
specification)*; tests pin both. The address is relative, so the
middleware still reads no setting.

## The relative address (measured)

Measured on this machine with Chromium 153 (headless, user agent
`HeadlessChrome/153.0.0.0`), driven by Playwright 1.56.1, against a
scratch Node.js server on `localhost` that answered one document with
an inline script refused, under each header variant, and logged every
`POST` it received. The Reporting API's own events (Chrome DevTools
Protocol, `Network.enableReportingApi`) showed what was registered.

| Document | Headers | What the server received |
| --- | --- | --- |
| `https://localhost` | `report-to csp`, `csp="/api/csp-report"` | one `application/reports+json` batch at `/api/csp-report` |
| `https://localhost` | the same with an absolute address | the same |
| `https://localhost` | both directives and the header | the `reports+json` batch alone |
| `https://localhost` | both directives, no header | nothing |
| `https://localhost` | `report-uri` alone | one `application/csp-report` |
| `http://localhost` | `report-to`, relative or absolute | nothing; no endpoint registered |
| `http://localhost` | `report-uri` alone | one `application/csp-report` |
| `http://localhost` | both directives and the header | nothing in 30 seconds |
| `http://localhost` | both directives, no header | nothing in 30 seconds |

- Chromium resolved `/api/csp-report` against the page's address
  (registered as `https://localhost:<port>/api/csp-report`, group
  `csp`) and posted within 15 seconds, with Playwright's default
  switches and no short-delay switch. The certificate was a throwaway
  one, accepted by its public key hash
  (`--ignore-certificate-errors-spki-list`) so no certificate error
  was in play.
- **Over plain `http`, even on `localhost`, Chromium registered no
  endpoint**, relative or absolute, and kept the report queued. With
  `report-to` in the policy it then sent no `report-uri` post either
  (the last two rows, measured later with Chromium 153.0.8010.12), so
  a page served by `next dev` reports nothing. Production is
  `https`. The browser test strips `report-to` for that reason.
- Playwright's page and context saw the `report-uri` post (resource
  type `other`) and never the `report-to` upload, which the browser's
  network service sends (critique NIT 10).
- No console message about `report-uri`, `report-to` or the Reporting
  API appeared in any variant: only the refusal itself and the
  missing icon's 404 (critique NIT 9). The browser test's guard needs
  no change.
- The captured bodies have no column number in either shape;
  `csp-report.test.ts` now counts both as captured.

Firefox and Safari were not measured. Firefox's support for
`report-to` is unsure *(inference)*; it posts by `report-uri`.

## The `page` category

The line's violations gain `page`: the document's route pattern,
matched segment by segment against a fixed list of the app's 17 page
patterns (`PAGE_PATTERNS` in `apps/web/src/lib/csp-report.ts`, which a
test holds equal to every `apps/web/src/app/**/page.tsx`). A dynamic
segment matches an id of 1 to 64 letters, digits, `-` or `_`, which
also bounds a matching path at 164 characters. Anything else, or
another origin, is `(other)`. The path, query and ids are never
logged:

```json
{"mechanism":"report-uri","page":"/properties/[propertyId]/review",
 "directive":"script-src-elem","blocked":"inline","disposition":"enforce",
 "source":"other","count":1,"total":1}
```

**The key space** grows from 4,104 to 4,104 × (17 + 1) = **73,872**
keys per instance. A key still writes at most ⌊log₂ n⌋ + 1 lines for
n reports, and a request at most one line. A million forged reports,
one per request, spread evenly over every key, about 13 each, reach 1,
2, 4 and 8 on each key: 73,872 × 4 = 295,488 lines. Spent to write the
most lines, the same million first bring every key to 8 (590,976
reports, 295,488 lines), then 51,128 keys to 16: at most 346,616
lines. On one key, still 20.
Each Cloud Run instance multiplies this, and a restart clears it.

## The production-mode job

A new step, "Post page policy reports", posts through the job's TLS
front, with its own `Origin` and authority:

| Report | Answer | Line |
| --- | --- | --- |
| `report-uri`, `/login`, inline refused | `204` | one `INFO` |
| `report-to`, `/login`, inline refused | `204` | one `INFO` |
| `report-uri` from `https://elsewhere.rd11.test/login` | `204` | none |
| `report-uri` over 16 KiB | `413` | none |

A run-unique mark is in each page address's query, referrer, policy
and source address, in the `report-to` user agent, and in the blocked
address of the two reports that write no line; the accepted two must
name `inline`. The mark is appended to `all-values`, so the log report
exits 2 if it appears. `log-report.mjs` requires exactly one
`csp-report` line per mechanism, each `INFO`, with one violation of
page `/login` and blocked `inline`, and fails on any other
`csp-report` line, which is what the report naming another origin's
page would write. That report is a synthetic `POST`, built by the
step's own commands, not a browser's: it holds the origin filter on
the image. A browser's report from a second origin is measured below.

## A browser on a second origin (critique B1's check)

Measured on this machine with Chromium 153.0.8010.12 (headless),
driven by Playwright 1.56.1. A scratch Node.js server on `localhost`
answered `POST /api/csp-report` with the endpoint's own
`answerCspReport`, its `APP_BASE_URL` its own origin; it is not the
Next.js app. A second scratch server on `127.0.0.1`, another origin,
answered a page whose policy refused an inline script and aimed
`report-uri` at the first by its absolute address. The same page on
the first server's origin, with `report-uri /api/csp-report`, was the
control.

| Page | What the endpoint received | Answer | Line |
| --- | --- | --- | --- |
| the control, `localhost` | one `application/csp-report`, `Origin` `localhost`'s | `204` | one `INFO`, page `/login` |
| `127.0.0.1` | one `application/csp-report`, `Origin` `127.0.0.1`'s, `document-uri` the `127.0.0.1` page | `204` | none |

So a browser does deliver another site's report here, naming that
site's page, and the endpoint drops it. Had it been counted, it would
have written a line, as the first report of any key does.

## Measured from a production build

From `next start` on a production build of this tree (`next build`
with `NODE_ENV` unset), with stand-in settings and
`APP_BASE_URL=https://app.rd10.test`:

```text
GET /login         200  content-security-policy: ...; frame-ancestors
                        'none'; report-uri /api/csp-report; report-to csp
                        reporting-endpoints: csp="/api/csp-report"
GET /no-such-page  404  reporting-endpoints: csp="/api/csp-report"
GET /api/x         404  Content-Security-Policy: default-src 'none';
                        frame-ancestors 'none'; sandbox
                        (no reporting-endpoints)
```

The production-mode step's four bodies, built by its own commands
with the origin changed to the stand-in's, answered `204`, `204`, `204`
and `413`, and wrote exactly these two lines:

```json
{"severity":"INFO","time":"2026-11-26T17:31:58.033Z","message":"Browsers reported page policy violations","component":"csp-report","violations":[{"mechanism":"report-uri","page":"/login","directive":"script-src-elem","blocked":"inline","disposition":"enforce","source":"other","count":1,"total":1}],"dropped":0}
{"severity":"INFO","time":"2026-11-26T17:31:58.044Z","message":"Browsers reported page policy violations","component":"csp-report","violations":[{"mechanism":"report-to","page":"/login","directive":"script-src-elem","blocked":"inline","disposition":"enforce","source":"other","count":1,"total":1}],"dropped":0}
```

The run's mark appeared nowhere in the log, and the report naming
another origin's page wrote nothing. `log-report.mjs` accepted the two
lines (beside the outage and uncaught-error lines it also requires)
and failed with one more `report-uri` line.

## Not applicable

- **Entity-relationship diagram, database migration:** no table or
  column changes.
- **OpenAPI:** the repository has no OpenAPI file; `docs/API.md` lists
  the route, unchanged.
