# Phase 4C-3B-2H-3B-1 — Dormant Streaming Managed Output Transfer Core

- Base: `07ac915f4fbdd9f171527f33aa84ccc766ec5b28`
- Decision record: ADR-0041
- Migration: **none**
- Paid provider activation: **still blocked**

## What this phase adds

One concrete implementation of Phase 2H-2's `ManagedOutputTransferPort` —
`StreamingManagedOutputTransfer` in `@app/storage` — and the two contracts it
consumes: a provider-neutral `ProviderOutputByteSource` in the domain, and a
`ManagedOutputStagingSink` in storage. Neither contract has a real
implementation. The core is proved against deterministic fakes, and the static
suite asserts nothing in production constructs it.

## The dormancy claim, precisely

The core is concrete: it really hashes, stages and publishes. What keeps it
dormant is not that it cannot act but that nothing gives it the two things it
needs to act on, and nothing constructs it.

| Claim | How it is held |
| --- | --- |
| Nothing in production constructs the core | Static scan over every `apps/*`, `packages/database`, `packages/video-providers`, `packages/storage` and `packages/domain` source, excluding tests and `testing/` |
| No production byte source exists | The same scan finds no `implements ProviderOutputByteSource` |
| No production staging sink exists | The same scan finds no `implements ManagedOutputStagingSink` |
| The Phase 2H-2 runner still has no caller | The same scan, for all three entry points |
| No storage or provider credential exists | `FAL_KEY`, AWS, R2, Azure and GCS variables absent from the environment schema |
| No test reaches a network or an object store | Both fakes are in-memory; the core imports only `@app/domain`, `@app/shared` and `node:crypto` |
| The fakes are not on the package root | `@app/storage` exports the core; the fakes live only under `@app/storage/testing` |

**A concrete streaming transfer core exists. It has no production byte source,
no production staging sink, no production composition, and no credential.**

## Why the existing pieces were not reused

| Existing piece | Its contract | Why not |
| --- | --- | --- |
| Provider `HttpClient` | One request, one **string** body, no retries | Right for a status poll; wrong for half a gigabyte. Control plane and data plane get separate narrow contracts; `http.ts` is unchanged and still string-bodied |
| `LocalObjectStorage` | Whole `Uint8Array`, in process memory, non-production | Adapting it would mean buffering a complete video to hand it an array. Unchanged, still serving photos, still refusing production |

## What one transfer does

```text
open the source                  RETRYABLE_FAILURE → return it; throw → propagate
check the declared size          over the limit → RETRYABLE_FAILURE, no staging
begin an isolated staging write
for each chunk, one at a time    count → limit check → hash → write (backpressure)
zero bytes                       abort → RETRYABLE_FAILURE
commit with the computed receipt
  PUBLISHED                      VERIFIED with the computed receipt
  EXISTING                       VERIFIED with the canonical object's receipt
  RETRYABLE_FAILURE              abort → RETRYABLE_FAILURE
close the source                 always, exactly once
```

| Property | Held by |
| --- | --- |
| **Bounded memory** | `for await` over a pull-based body, awaiting each `write`; one chunk in hand at a time. With the sink blocked on its first write, exactly one chunk has been pulled |
| **Bounded size** | 512 MiB hard ceiling; configured limit refused (never clamped) if invalid or higher. Declared size is preflight only; every actual byte is counted before it is hashed or written |
| **Incremental SHA-256** | `createHash("sha256")` updated per chunk, finalized once after the loop; no concatenation anywhere |
| **Zero bytes refused** | Never a canonical object, never `VERIFIED`, never a manufactured size |
| **Staging isolation** | The canonical key is untouched until `commit` says `PUBLISHED`; asserted at every write |
| **First publish wins** | A second session, same or different bytes, receives `EXISTING`; the canonical object is never overwritten |
| **Receipt recovery** | `EXISTING` carries the canonical object's receipt, and the core reports *that* — not the receipt for the bytes it just abandoned |
| **Cleanup exactly once** | `close()` once on every path out of a successful open; `abort()` on every failure after `begin`, never after a success; both best effort, neither ever the answer |
| **Cleanup on a malformed open** | An OPEN-shaped malformed result with an object `stream` is closed once, best effort, **whether or not the stream is valid** — the wrapper being defective does not make a valid handle less worth releasing. The defect raised follows the stream's validity: valid stream → the wrapper's defect; malformed stream → the stream's. Obtaining `close` is inside the guard, so a throwing getter cannot replace the fixed defect (Revision 2) |
| **Failures never blame the provider** | Every expected condition returns `RETRYABLE_FAILURE`; every adapter defect throws fixed text; Phase 2H-2 leaves the attempt `OUTPUT_INGESTING` in both cases |
| **Locator unread** | Passed to the source by reference; no accessor exists, none was added, and the core does not look |

## Crash after publish, before finalization

Runner A publishes the canonical object and dies before
`finalizeOutputVerification`. Runner B resumes the `OUTPUT_INGESTING` attempt,
downloads again — the bytes differ — stages, and commits. The sink answers
`EXISTING` with A's receipt; the core reports A's receipt; Phase 2H-1 finalizes
the row against A's object. Canonical bytes are A's. Proved at the unit level
and against live PostgreSQL through the real runner.

No transfer lease was added. A lease would buy a duplicate-free download at the
price of a durable lock whose holder can die, and a lease column would be a
migration. First-publish-wins gives the property that matters without either.

## What remains unverified, on purpose

The receipt proves a digest and a byte count. It does **not** prove MP4, WebM,
a codec, a resolution, a duration, playability or a MIME type. No `ftyp` box is
inspected, no `ffprobe` runs, no MIME column exists, no extension is appended:
the key remains `org/{organizationId}/generations/{attemptId}/output`. Media
validation is a delivery-readiness prerequisite for a later phase.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — all 10 projects, including the `@ts-expect-error` brand proofs |
| `pnpm lint` | Pass — 0 problems |
| `pnpm test` | **3691 passed**, 113 files (was 3478 / 108) |
| `pnpm test:db` (live PostgreSQL) | **745 passed**, 23 files (was 728 / 22) |
| `pnpm build` | Pass |
| Prisma drift | `No difference detected` |
| 2F-1 / 2G-1 / 2G-2 / 2H-1 / 2H-2 / 2H-3A regressions | Pass, unchanged |

213 unit tests and 17 database tests added. No pre-existing
test modified, weakened or removed.

## Mutation ledger

**24 mutations, 24 killed, no survivors.** Nineteen are the required list;
three (M01a, M20, M21) are additional; two (M22, M23) were added with the
Revision 2 correction.

| # | Defect | Killed by |
| --- | --- | --- |
| M01a | Destination key type widens back to a plain string | `pnpm typecheck` — every `@ts-expect-error` in the brand proof becomes unused |
| M01b | The runner passes a caller-chosen string as the destination | 4 |
| M02 | Declared size limit is ignored | 2 |
| M03 | Actual byte limit is ignored | 9 |
| M04 | Zero-byte output is treated as streamed | 8 — the domain's `safePositiveByteCount` refuses `0` as a second line |
| M05 | Byte count uses the declared size instead of the actual count | 2 |
| M06 | The first chunk is omitted from SHA-256 | 13 |
| M07 | The hash is finalized after the first chunk | 6 |
| M08 | The source is drained eagerly before any write | 12 — the backpressure test and the source-level guard both |
| M09 | The source is never closed | 34 |
| M10 | Staging is not aborted after oversize or empty | 4 |
| M11 | Staging is not aborted after a write or iteration failure | 11 |
| M12 | The reference sink overwrites the canonical object (last-writer-wins) | 6 — targets the fake's first-publish semantics, proving a real sink that overwrote would be caught |
| M13 | `EXISTING` reports the proposed receipt instead of the canonical one | 6 |
| M14 | Commit is issued after the first chunk, before all bytes are written | 22 |
| M15 | A `RETRYABLE_FAILURE` commit is reported as `VERIFIED` | 4 |
| M16 | A malformed commit result is accepted | 12 |
| M17 | `LocalObjectStorage` is pulled into the transfer core | 1 — the static guard |
| M18 | The full output is accumulated in memory alongside streaming | 1 — the static `Buffer.concat` guard; behaviourally invisible, which is why the guard exists |
| M19 | A session advisory lock is left held across the transfer | 10 — every live-PostgreSQL test that reaches a write blocks and times out |
| M20 | A non-bytes chunk is hashed and written rather than refused | 6 |
| M21 | The open result is trusted without validation | 11 |
| **M22** | **A valid stream inside a malformed OPEN wrapper is not closed** (the rejected head's selection) | 3 — exactly the three focused wrapper tests; fails against `229d484…`, passes after |
| **M23** | **The `close` lookup happens outside the best-effort cleanup guard** | 2 — the two throwing-`close`-getter tests |

Counts are failures in **this phase's suites only**. M17 and M18 are killed by a
single static assertion each — that is the honest mechanism for a property the
behavioural tests cannot observe, and it is stated as such rather than padded.

## Not done

- **No concrete fal byte source.** `ProviderOutputByteSource` has no
  implementation; the locator still cannot be dereferenced by anything.
- **No durable staging sink.** No S3, R2, Azure Blob, GCS, multipart upload or
  production filesystem. `ManagedOutputStagingSink` has no implementation
  outside the test fake.
- **No media validation.** Format, codec, duration and playability remain
  unproved.
- **No production composition.** No route, worker loop, bootstrap or scheduler
  constructs the core or calls either 2H-2 runner.
- **No Scene delivery or Job readiness.** `OUTPUT_VERIFIED` is provider-attempt
  integrity only.
- **No paid activation.** `FAL_KEY` unwired; fal and Veo production execution
  disabled; WaveSpeed paid routing unchanged; no payment integration; the
  provider-contract reverification is still outstanding.
