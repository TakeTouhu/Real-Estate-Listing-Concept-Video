# API Changes — PT-7c4

Pages upgrade insecure requests; the HSTS rule is written down
(ADR-0190). Production readiness, part 2. **No route, stored value,
setting, image or migration changes.** What changes is the production
page policy, by one directive, and the tests that hold it and HSTS's
grammar.

## The page policy, before and after

Production, before (PT-7c3), with `{n}` the request's nonce:

```text
default-src 'self'; script-src 'self' 'nonce-{n}' 'strict-dynamic';
style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self';
font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none';
form-action 'self'; frame-src 'none'; frame-ancestors 'none';
report-uri /api/csp-report; report-to csp
```

After, the same with one directive at the end, with no sources:

```text
...; report-uri /api/csp-report; report-to csp; upgrade-insecure-requests
```

Every `NODE_ENV` but `development` gets it. **`next dev`'s policy is
unchanged**, and so is the API policy,
`default-src 'none'; frame-ancestors 'none'; sandbox`. `sandbox` is
still absent from the page policies.

## What a browser does with it

It asks the `http://` subresources and form targets a page names, and
links to its own host, over `https` (ADR-0190 Decision 1). Today no
page names one, so nothing a customer sees changes. Measured with Chromium
153 on a production build (ADR-0190):

| Opened as | Static files | Hydrated |
| --- | --- | --- |
| `https://localhost:8443` through a TLS front | 5 over `https`, none failed | yes, no refusal |
| `http://localhost:3456`, `http://127.0.0.1:3456` | 5 over `http`, not upgraded | yes |
| `http://app.pt7c4.test:3456` (same server) | 5 upgraded to `https`, all failed | no |

So a production build served over plain `http` broke in Chromium on
the one non-loopback name measured. A LAN address or another hosts-file
name is expected to break the same way *(inference: Chromium exempts
only potentially trustworthy hosts; `*.localhost` names may not
break)*. `docs/local-setup.md` says to use `next dev` locally.

## HSTS

The value is unchanged: `max-age=31536000`, from production builds
only. A test now holds the grammar it may change within: `max-age` of
at least one year first, `includeSubDomains` as that literal token,
`preload` only beside it, nothing else. `max-age=0` is refused, so an
emergency withdrawal edits the test. When `includeSubDomains` and
`preload` may be added is ADR-0190 Decision 3, after the product
owner's domain decision (PT-7c5).

## Not applicable

- **OpenAPI:** no route, request or response body changes.
- **ER diagram and migration:** no stored value changes.
