# API Changes — RD-9a

The origin check compares `Origin` with `APP_BASE_URL`'s origin where it
is set, refuses in production where it is not, and logs each refusal by
its reason (ADR-0174). A test of every route file names the handlers
still unchecked. **No migration, no dependency and no new setting.**
ADR-0174 also decides the rest of RD-9, which RD-9b to RD-9e build.

## HTTP

The 20 routes that already check their origin (ADR-0068, ADR-0111 and
later milestones) now decide it this way; no other route changes.

| Where | Before | After |
| --- | --- | --- |
| `APP_BASE_URL` set | `Origin`'s host equals the first `X-Forwarded-Host`, else `Host` | `Origin` equals `APP_BASE_URL`'s origin: scheme, host and port; `Host` is not read |
| unset, production | the host rule | every change refused |
| unset, elsewhere | the host rule | the host rule, unchanged |

A refusal is the route's `403 FORBIDDEN` answer, as before. An `http`
page on the configured `https` host, the service's own address and any
other host name are now refused where the setting is set.

## Pages

None changed.

## Environment

None added. `APP_BASE_URL` must be the exact origin the browser opens:
`.env.example` and `docs/local-setup.md` say so.

## Internal API

| Change | Where |
| --- | --- |
| New: `originRefusal(request, setting)`, `OriginRefusal`, `OriginSetting` | `apps/web/src/lib/same-origin.ts` |
| `isSameOriginPost(request, route?)` takes an optional `METHOD /path`, for its log | same |

## Logs

`warn` `{ component: "same-origin", code: "ORIGIN_REFUSED", reason,
route }` per refusal; `reason` is `NO_ORIGIN`, `OPAQUE`, `MISMATCH`,
`NO_HOST` or `NO_SETTING`, and `route` is present only where the call
names it (none of today's 20 does). No header value, address or user is
logged. Refusals are not audited.

## Tests and CI

New `tests/api/same-origin-coverage.test.ts`: every mutating handler of
every route file checks its origin before its first `await`, but the 25
it lists, 24 for RD-9b and RD-9c and `PUT /api/storage/upload` for good.
`same-origin.test.ts` gains the configured origin, the production
refusal and the log. `invitation-routes.test.ts` posts from the
configured origin; `invitation-acceptance-routes.test.ts` sets it for
its production case. CI is unchanged: the unit job sets no
`APP_BASE_URL`, and the browser test sets it to the address Chromium
opens.
