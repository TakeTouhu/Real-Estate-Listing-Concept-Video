# Phase 4C-3B-2H-3B-2 — Dormant fal streaming output byte source

- Base: `7ff3fe66b3adf35337a3bde37f87c3b3911f3d87` (merge commit of PR #61)
- Decision record: ADR-0042
- Migration: **none**
- Paid provider activation: **still blocked**

## What this phase adds

One bundled provider-output acquisition boundary, in four parts:

1. **The deferred Phase 3B-1 malformed-OPEN cleanup P2 is closed.** The
   parse-then-reinspect split in the streaming core is replaced by a single
   authority, `inspectProviderOutputByteSourceOpenResult`, that reads each raw
   top-level property once and carries a captured cleanup capability on the
   malformed arm. The core never returns to the raw `opened` value.
2. **A narrow locator-read capability with a closed return channel.**
   `withTransientProviderOutputLocatorForByteSource(locator, use)` takes
   `use: (rawLocation: string) => Promise<void>` and itself returns
   `Promise<void>`, so it is not a general-purpose unwrap function — the raw
   string cannot be returned back out through the capability, proved by a
   compile-time `@ts-expect-error` regression. Exported only from
   `@app/domain/provider-output-byte-source-access` and, in production, imported
   only by the authorized fal adapter. The security model is stated honestly:
   `#raw` blocks structural access and the subpath gates the friend capability,
   but the language cannot confine the string once the trusted adapter has been
   handed it.
3. **A fal output URL authority**, fail-closed to signed `https://fal.media`
   artifact URLs, applied both in the fal result mapping and again immediately
   before every request.
4. **`FalProviderOutputByteSource`** — the first concrete production
   `ProviderOutputByteSource`: GET-only, no credential, manual re-validated
   redirects, a streaming body that never buffers, an idempotent close.

## The dormancy claim, precisely — as it now stands

The one thing that changed: a concrete fal `ProviderOutputByteSource` exists.

| Claim | How it is held |
| --- | --- |
| Exactly one production file implements `ProviderOutputByteSource` — the fal adapter | Static scan over `apps/*`, `packages/{database,video-providers,storage,domain}` production source |
| Nothing in production constructs the fal byte source | The same scan finds no `new FalProviderOutputByteSource` outside the adapter and its package root export |
| Nothing in production constructs the transfer core | The same scan, `new StreamingManagedOutputTransfer` |
| No durable staging sink exists | The same scan finds no production `implements ManagedOutputStagingSink` |
| The Phase 2H-2 runner has no production caller | The same scan, all three entry points |
| No `FAL_KEY` or storage credential exists | Absent from the environment schema |
| Only the authorized adapter reads the locator | Access-guard test: exactly one production importer of the byte-source-access subpath |
| No real network in tests | Both the adapter and the end-to-end test drive an injected fetch seam |

**A concrete fal output byte source exists, but no production code constructs
it, no durable managed-output staging sink exists, and no production composition
can execute the transfer path.**

## The deferred P2, closed

| Property | Held by |
| --- | --- |
| Raw `kind` read at most once | `inspectProviderOutputByteSourceOpenResult` reads `value.kind` into a local; the core acts only on the inspection |
| Raw `stream` read at most once | The same inspection reads `value.stream` into a local once; no `openStreamCandidate` re-read remains |
| Stream `body` / `[Symbol.asyncIterator]` / `declaredSizeBytes` / `close` each read at most once | `inspectProviderOutputByteStream` reads each once; the captured stream re-exposes the iterator factory as a plain method and invokes the captured close against its original receiver |
| Cleanup preserved through a later validation failure | `close` is captured **first**, before body/size/iterator validation; a bad body, size, iterator or `ownKeys` trap still yields the captured cleanup |
| A throwing `close` getter yields no capability and does not escape | The capture is guarded; the getter's error becomes "no cleanup", never a thrown value |
| Fixed defect classifications preserved | Valid stream in a bad wrapper → `BYTE_SOURCE_OPEN_RESULT_MALFORMED`; malformed-but-closable stream → `BYTE_SOURCE_STREAM_MALFORMED`; no adapter/runtime text, no `cause` |
| Stateful top-level getter trap never sprung | A top-level `kind` or `stream` getter that answers once then throws is read once; the observed stream is still closed exactly once |

## The fal output URL authority

Accepted: absolute `https:`, host exactly `fal.media` or ending `.fal.media`, no
userinfo, no explicit port, no fragment, path under `/files/`. Query string
allowed and never rewritten. Refused: `http:`, `fal.media.evil.example`,
`evilfal.media`, `fal-media.example`, `user:password@fal.media`,
`fal.media@evil.example`, an explicit port, `/not-files/`, loopback,
`localhost`, `file://`, a fragment, a query that merely names fal on another
host. Applied in `parseFalH3MaxOutputUrl` (unauthorized → `SUCCEEDED` +
`outputLocator: null`) and again before every byte-source request.

## The byte source

| Rule | How it is held |
| --- | --- |
| The signed URL is the only authorization | GET carries no `Authorization`, no `FAL_KEY`, no cookie; the fetch seam accepts only a URL |
| No buffering | One chunk pulled per consumer iteration; never `.text()`, `.json()`, `.arrayBuffer()`, `Buffer.concat`, or a whole-body array |
| Backpressure preserved | The generator pulls the next chunk only when asked; the end-to-end test holds the sink at its first write and shows exactly one chunk pulled |
| Manual, re-validated redirects | At most three; each `Location` resolved and re-checked against the same policy before the next request; a non-fal target refused before dialing |
| Every failure is retryable | Non-200, network rejection, missing/over-budget redirect, null body → `RETRYABLE_FAILURE`, never a provider failure, never a throw carrying URL text |
| `Content-Length` is a hint | A positive safe integer or `null`; the actual streamed count overrides it |
| `close()` releases and is idempotent | Cancels the underlying response once; early termination releases through the same guard |

## End-to-end dormant proof

`tests/dormant-fal-output-data-plane.test.ts` composes the real
`FalProviderOutputByteSource`, an injected fake fetch, the real
`StreamingManagedOutputTransfer` and the fake staging sink — no network, no
object store — and proves: opaque locator → controlled access → authorized fal
URL → streaming fake body → incremental hash and count → staging publish →
`VERIFIED` receipt; the canonical object holds exactly the streamed bytes; the
locator and its signature never reach the outcome; the actual count overrides a
smaller declared size; and with the sink blocked on its first write exactly one
chunk has been pulled.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — all projects |
| `pnpm lint` | Pass — 0 problems |
| `pnpm test` | **3875 passed**, 118 files (was 3787 / 114 at the 3B-1 merge) |
| `pnpm test:db` (live PostgreSQL) | **755 passed**, 23 files (unchanged; this phase's data-plane test is an in-memory unit test) |
| `pnpm build` | Pass |
| Prisma drift | `No difference detected` |
| 2F-1 / 2G-1 / 2G-2 / 2H-1 / 2H-2 / 2H-3A / 2H-3B-1 regressions | Pass |

**No migration and no schema change; `packages/database` untouched.**

## Mutation ledger

**38 mutations, 38 killed, no survivors.** The Phase 3B-1 ledger (thirty-one)
carries forward, with M21, M22, M23 and M31 re-aimed to the new single
inspection authority; six are added for this phase (M32–M37, with M37 added by
the locator-access correction).

| # | Defect | Killed by |
| --- | --- | --- |
| **M37** | The locator-access capability restores a generic arbitrary-return channel | the compile-time direct-extraction regression (`@ts-expect-error` on `async raw => raw` becomes unused → domain typecheck fails) |
| **M32** | The malformed-OPEN cleanup re-reads raw `opened.stream` after inspection | the stateful top-level stream/kind getter core tests |
| **M33** | Redirect targets are dialed without validating them against the fal output policy | the non-fal-host, loopback and scheme-downgrade redirect tests |
| **M34** | The raw locator read-back is re-exported from the `@app/domain` root | the access-guard test asserting the root exposes no reader |
| **M35** | The fal output body is buffered whole instead of streamed | the lazy-pull adapter test and the end-to-end backpressure test |
| **M36** | An `Authorization` header carrying the fal key is attached to the output GET | the adapter's credential source-scan test |
| M21 | The open result is trusted without validating its exact keys (re-aimed) | the OPEN-wrapper-with-extra-key tests |
| M22 | A valid stream inside a malformed OPEN wrapper is not closed (re-aimed) | the close-once wrapper tests |
| M23 | The stream close capture reads the getter outside its guard (re-aimed) | the throwing-close-getter tests |
| M31 | The stream inspection returns the raw handle uncaptured (re-aimed) | the stateful stream-getter core and unit tests |

## Not done, on purpose

- **No production composition.** No route, worker loop, bootstrap or scheduler
  constructs the fal byte source, the transfer core, or calls the runner.
- **No durable staging sink.** No S3, R2, Azure Blob, GCS or production
  filesystem; `ManagedOutputStagingSink` has no production implementation.
- **No credential or paid activation.** `FAL_KEY` unwired; no real fal request;
  no paid submission; no Scene delivery, Job readiness, quota consumption,
  `SYSTEM_RECOVERY`, pricing or resolution change.
- **No media validation.** Format, codec, duration and playability remain
  unproved; the key stays extensionless.
