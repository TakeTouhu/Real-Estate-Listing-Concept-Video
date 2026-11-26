# API Changes — PT-7c2

Browsers report page policy violations to an endpoint that logs only
categories (ADR-0189). Production readiness, part 2. **One new route;
no stored value, setting, image or migration changes.** Nothing points
at the route until PT-7c3.

## `POST /api/csp-report`

Unauthenticated; reads no cookie, session, database or limiter; not
audited; outside the origin check (ADR-0174 Decision 1's scope).

| Request | Answer | Line |
| --- | --- | --- |
| `Content-Type` other than `application/csp-report` or `application/reports+json` (parameters ignored) | `415` | none |
| `Content-Length` over 16,384 | `413`, body not read | none |
| Body passing 16,384 bytes while read | `413`, stream cancelled | none |
| Body that cannot be read, is not JSON, or is not its type's shape | `400` | none |
| Valid; no violation on `APP_BASE_URL`'s origin | `204` | none |
| Valid; a category's count in this instance reaches 1, 2, 4, 8 ... | `204` | one `INFO` |
| Valid otherwise | `204` | none |

Every answer has an empty body. A `reports+json` batch is read for
`csp-violation` entries only, ten at most; the rest are `dropped`.

## The line

Measured from `next start` on a production build of this tree, with
stand-in settings and `APP_BASE_URL=https://app.rd10.test`. The
report-uri body named `/reset-password?token=s3cret` as its page, an
inline script refused, a nonce in `original-policy`, a referrer and a
`script-sample`; the `reports+json` body named a property page with
`?token=s3cret`, a signed download link as the blocked address and a
`chrome-extension:` source. Posted three times, the report-uri body
wrote a line on the first and second only:

```json
{"severity":"INFO","time":"2026-11-26T16:37:50.624Z","message":"Browsers reported page policy violations","component":"csp-report","violations":[{"mechanism":"report-uri","directive":"script-src-elem","blocked":"inline","disposition":"enforce","source":"other","count":1,"total":1}],"dropped":0}
{"severity":"INFO","time":"2026-11-26T16:37:50.635Z","message":"Browsers reported page policy violations","component":"csp-report","violations":[{"mechanism":"report-uri","directive":"script-src-elem","blocked":"inline","disposition":"enforce","source":"other","count":1,"total":2}],"dropped":0}
{"severity":"INFO","time":"2026-11-26T16:37:50.658Z","message":"Browsers reported page policy violations","component":"csp-report","violations":[{"mechanism":"report-to","directive":"media-src","blocked":"self","disposition":"enforce","source":"extension","count":1,"total":1}],"dropped":0}
```

The same bodies from another origin's page answered `204` with no
line; `text/plain` `415`; 20 KiB with `Content-Length` `413`; 20 KiB
chunked with no `Content-Length` `413`. No other line was written, and
none of `s3cret`, the nonce, a token, a path, the property's id or an
outside host appears in the log.

## Not applicable

- **Entity-relationship diagram, database migration:** no table or
  column changes.
- **OpenAPI:** the repository has no OpenAPI file; `docs/API.md` lists
  the route.
