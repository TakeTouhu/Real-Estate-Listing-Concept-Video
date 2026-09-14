# ADR-0042: The fal output byte source reads a signed URL through one narrow door, over a fail-closed policy, and stays dormant

- Status: Accepted
- Date: 2026-09-14
- Phase: 4C-3B-2H-3B-2
- Implements: ADR-0039's `ProviderOutputByteSource`, declared as a port with no
  implementation; consumed by ADR-0041's streaming transfer core
- Relates to: ADR-0016 and ADR-0038 (a transient provider output location is a
  bearer credential and is never persisted), ADR-0040 (control-plane HTTP reads
  bodies into strings; the fal queue status source), ADR-0041 (the streaming
  transfer core and its single-inspection open-result boundary), ADR-0031
  (application-owned error vocabulary, no external text)

## Context

Phase 4C-3B-2H-3B-1 shipped a concrete streaming transfer core with no real
byte source to feed it: `ProviderOutputByteSource` was a port, and the
`TransientProviderOutputLocator` it consumes had, by design, **no way to read
its raw value back**. This phase makes the first real byte source — the thing
that actually dereferences a signed fal media URL and streams the video — while
keeping the whole pipeline dormant, and it closes one deferred defect on the way.

Four decisions in this ADR belong together because they are one boundary: the
point where an opaque, credential-bearing location becomes a real network
request.

## Decision 1 — The malformed-OPEN cleanup no longer re-reads the raw result

Revision 6 of Phase 3B-1 materialized the *success* paths of the open-result
boundary but left a time-of-check/time-of-use gap on the *malformed* path: after
`parseProviderOutputByteSourceOpenResult` returned `null`, the core called a
second helper that re-read the raw `opened.kind` / `opened.stream`. A stateful
top-level getter could answer once during inspection and then throw or change on
that second read, losing the cleanup candidate and leaking a response body.

The parse-then-reinspect split is replaced by a single authority,
`inspectProviderOutputByteSourceOpenResult`, that reads every top-level property
(`kind`, `stream`) exactly once, inspects the stream once (capturing its `close`
capability first, before validating anything else), and returns either a
materialized `VALID` result or a `MALFORMED` verdict carrying the fixed defect
reason and a captured cleanup capability. The storage core acts only on that
inspection and never returns to the raw value. `close` is captured early enough
that a later validation failure — a bad body, a bad declared size, a throwing
`[Symbol.asyncIterator]`, an `ownKeys` trap — cannot lose the ability to
release; a throwing `close` getter yields no capability and does not escape.
Revision 2's semantics are unchanged: a valid stream in a bad wrapper is closed
once then `BYTE_SOURCE_OPEN_RESULT_MALFORMED`; a malformed-but-closable stream is
closed once then `BYTE_SOURCE_STREAM_MALFORMED`. `openStreamCandidate` is gone.

## Decision 2 — Locator read-back is a single subpath-gated capability

The locator still has no accessor, no getter, no `toString` that reveals it. The
one controlled read is `withTransientProviderOutputLocatorForByteSource(locator,
use)`: it hands the raw string *into* a callback and never returns it, so the
value exists only for the length of one network open. The capability is
installed from a `static {}` block inside the class — the one scope where `#raw`
is legible to a helper — and is exported **only** from a dedicated subpath,
`@app/domain/provider-output-byte-source-access`, never from the `@app/domain`
root. A static access-guard test proves that in production exactly one file
imports that subpath: the authorized fal byte-source adapter. This is not a
general secret-unwrapper; it is the byte source's one door, kept deliberately
narrow, because a signed URL that can be assigned to a variable can be spread,
logged or serialized.

## Decision 3 — fal output routing is fail-closed to signed `fal.media`

`isAuthorizedFalOutputUrl` accepts only an absolute `https:` URL whose host is
exactly `fal.media` or ends in `.fal.media`, with no userinfo, no explicit port,
no fragment, and a path under `/files/`. Query parameters — where the signed
credential lives — are allowed and never rewritten. Every look-alike is refused:
`fal.media.evil.example`, `evilfal.media`, `fal.media@evil.example`, a
`user:password@` authority, an explicit port, a scheme downgrade, a loopback IP.
The verdict is a boolean; the candidate URL is never logged or returned.

The policy is applied **twice**, on purpose. First in the fal result mapping:
`parseFalH3MaxOutputUrl` returns `null` for an unauthorized `video.url`, so an
unauthorized location becomes `SUCCEEDED` with `outputLocator: null` — provider
execution success is still recorded, never a failure. Second in the byte source:
the raw locator is re-validated immediately before every request, including the
first and every redirect target, because a locator that was authorized when
constructed is not assumed to be safe network authority now.

## Decision 4 — The output GET carries no key, and redirects are manual

The signed URL **is** the authorization, so the GET carries no `Authorization`
header, no `FAL_KEY`, no cookies. Adding one would send our submission
credential to a media host that does not need it. The existing string-body
`HttpClient` is not reused: it reads a whole response into a `string`, right for
a status poll and catastrophic for a video. The byte source streams through a
narrow, injectable fetch seam — one chunk pulled per consumer iteration, nothing
read ahead, the whole body never held — and never calls `.text()`, `.json()` or
`.arrayBuffer()`.

Redirects are followed manually, at most three, each `Location` resolved against
the current URL and re-validated against the same fal output policy *before* the
next request. A redirect to any other host is refused before a byte leaves. A
non-200 final response, a network rejection, a missing or over-budget redirect,
or a body that cannot be read is `RETRYABLE_FAILURE` — this source has no
evidence a fetch failure is permanent, and provider success is a separate,
already-recorded fact. `Content-Length` is read only as a preflight hint and is
`null` unless it is a positive safe integer; the transfer core's count of the
bytes that actually arrive remains authoritative.

The default fetch seam, backed by the runtime `fetch`, exists for a future
wiring to inject but is never constructed in production here. Note that WHATWG
`fetch` with `redirect: "manual"` yields an opaque-redirect response whose status
is `0` and whose headers are unreadable, so the default cannot itself follow a
redirect — it surfaces one as a non-final response mapped to
`RETRYABLE_FAILURE`. The redirect routing is exercised through an injected seam
that exposes the real status and `Location`.

## Why this phase remains dormant

The dormancy claim narrows in exactly one respect: a concrete fal
`ProviderOutputByteSource` now exists. Everything else holds. Nothing in
production constructs the fal byte source or the transfer core; no durable
`ManagedOutputStagingSink` exists; no composition joins byte source, transfer
and sink; the Phase 2H-2 runner has no production caller; there is no `FAL_KEY`
in the environment schema, no scheduler, no cron, no daemon, no worker loop, no
real fal request in any test, no paid submission, no Scene delivery, no Job
readiness transition, no quota consumption, no `SYSTEM_RECOVERY`, no pricing or
resolution-contract change, and no migration. The static suites assert each of
these rather than describing them.

## Consequences

- The deferred Phase 3B-1 malformed-OPEN cleanup P2 is closed.
- The repository now contains code that would GET an already-issued fal output
  URL and stream it, gated behind a credential and a composition that do not
  exist. Activating it — real `FAL_KEY`, a durable sink, a production
  composition, a scheduler — is a later, explicit CTO phase.
- A future change that widens the fal output host family, follows a redirect
  without re-validation, attaches a credential to the GET, buffers the body, or
  exposes locator read-back from the domain root is caught by a focused test or
  the access guard, and gets the review it needs.
