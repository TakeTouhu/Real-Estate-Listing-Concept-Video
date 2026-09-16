# Phase 4C-3B-2H-3B-4 — Dormant managed-output media/container validation

- Base: `f7d0df2c1b6b70c72ee9ec4de34e5e707473814d` (merge commit of PR #64, VTaVision brand assets)
- Decision record: ADR-0044
- Migration: **none**
- Durable lifecycle change: **none** — `OUTPUT_VERIFIED` is unchanged
- Paid provider / AWS / ffmpeg activation: **still blocked**

## What this phase adds

A provider-neutral media-validation capability that nothing calls.

1. **`ManagedOutputMediaValidationPort`** — a domain contract taking only a
   destination key and the receipt the transfer already computed.
2. **A closed outcome model** with a total, materializing parser authority.
3. **`S3ManagedOutputMediaValidator`** — canonical object materialization with
   receipt re-verification before any inspection.
4. **`FfprobeMediaProbe`** — a concrete dormant `ffprobe`-backed inspector behind
   an injected process seam.
5. **Deterministic integration-style proof** over a fake S3 reader and a fake
   process runner that actually reads the materialized file.

## `OUTPUT_VERIFIED` is not redefined

| Fact | Meaning | Where it lives |
| --- | --- | --- |
| `OUTPUT_VERIFIED` | canonical managed bytes were copied and byte-level integrity was verified | unchanged durable attempt state |
| media validity | MP4-family container, usable video stream, real duration | **ephemeral** validation result only |

No new durable state, no media fact columns, no migration, no runner integration.
Where media validity enters the lifecycle is a later, reviewed decision.

## The outcome model

```text
VALID               normalized facts only
INVALID_MEDIA       CONTAINER_UNSUPPORTED | VIDEO_STREAM_MISSING
                    | VIDEO_DIMENSIONS_INVALID | DURATION_INVALID | PROBE_REJECTED
INTEGRITY_MISMATCH  the object is not the bytes the receipt describes
RETRYABLE_FAILURE   storage, materialization or inspector transient
```

`VALID` facts are exactly: `container` (`ISO_BMFF`), `durationMs`, `videoWidth`,
`videoHeight`, `videoStreamCount`, `audioStreamCount`. No raw ffprobe JSON,
filename, temp path, bucket, key, AWS metadata, process output, command string or
codec prose.

## Order of operations

| Rule | How it is held |
| --- | --- |
| Integrity before inspection | The object is streamed, hashed and counted; only a matching SHA-256 **and** byte count admits the probe. Mismatch → `INTEGRITY_MISMATCH`, probe never called |
| Observed emptiness is a mismatch | A clean EOF at zero bytes, after a successful open and close, is a successful determination that the object is empty. A well-formed receipt always carries a positive size, so the ordinary comparison rejects it as `INTEGRITY_MISMATCH` — not `RETRYABLE_FAILURE`, which would retry forever against a replacement that can never match. No zero-byte receipt type is invented. Acquisition failures (rejected GET, absent body, interrupted read, failed write, failed close) stay retryable |
| Actual bytes are authoritative | `Content-Length` is a preflight ceiling only; a misleading smaller or larger value does not change the verdict; ETag and metadata are never consulted |
| Ceiling reused | `MAX_MANAGED_PROVIDER_OUTPUT_BYTES`; an over-limit object never reaches the inspector |
| No whole-object buffering | Streamed chunk-by-chunk to a file; static test bans `transformToByteArray` / `.arrayBuffer` / `Buffer.concat` / `readFile` / chunk arrays |
| Malformed expected receipt | A caller/contract defect, not invalid media and not a retry |

## Temporary materialization

| Rule | How it is held |
| --- | --- |
| Random, app-owned directory | `mkdtemp` with a fixed prefix; no org id, attempt id, key, provider id or signed URL in any path component |
| Fixed filename | `input` — proven by test, so a process listing carries no tenant data |
| Exclusive create, owner-only | `open(path, "wx", 0o600)`; mode asserted where the platform supports it |
| Removed on every exit path | VALID, INVALID_MEDIA, INTEGRITY_MISMATCH, RETRYABLE_FAILURE, and an unexpected inspector defect — file **and** directory |
| Cleanup never replaces the result | Swallowed in `finally`; proven by a probe that deletes the directory itself |

### The materialization invariant

The canonical object is not merely *hashed while being copied*: every canonical
chunk must be completely materialized locally, and the local file must close
successfully, before the probe may inspect it.

```text
bytes admitted to the probe
  === bytes materialized to the temporary file
  === bytes hashed and counted from the canonical object
```

| Rule | How it is held |
| --- | --- |
| Short writes are honoured | Each chunk is written in a loop until every byte lands; the hash and byte count advance **only after** the chunk is fully on disk; the next S3 chunk is pulled only after that. Proven by a writer that takes a 12-byte chunk as 2 + 3 + 7 bytes and still produces the exact canonical file for the probe |
| Impossible progress ends the copy | Zero, negative, fractional or more-than-remaining `bytesWritten` → `RETRYABLE_FAILURE`, bounded (the writer is asked once, never again); partial file discarded; probe invocation count **0** |
| Success requires a successful close | A failing `close()` on the success path → `RETRYABLE_FAILURE` with no probe; a flush failure is never `INVALID_MEDIA`. Abandoned paths still close best effort |
| Acquired body released on open failure | If `GetObject` succeeded and the local open fails, the body is cancelled **exactly once**, never read, and the probe never runs |
| No raw local error escapes | Open, write and close failures carry no `cause` and no OS message into any outcome |
| Test seam is narrow | `ManagedOutputTempFileFactory` is private to the managed-output adapter — open, a possibly-short `write`, a fallible `close`. Production default is a plain `FileHandle`; it is **not** a filesystem abstraction |

## The inspector subprocess

| Rule | How it is held |
| --- | --- |
| No shell, ever | `execFile` with `shell: false`; static tests ban `shell: true`, `exec(`, `execSync`, `spawnSync`, `/bin/sh` and template-string commands |
| Fixed argument vector | `-v error -of json -show_format -show_streams <app-created-path>`; the path is the only variable argument |
| Nothing tenant-shaped on the command line | Asserted: no bucket, key, `s3://`, `org/`, `generations/`, fal host, signature or `.mp4` |
| Bounded | Validated timeout (default 15s, ceiling 120s) and stdout cap (default 1 MiB, ceiling 8 MiB); stderr discarded |
| Availability ≠ invalidity | real numeric non-zero exit → `PROBE_REJECTED`; timeout → `RETRYABLE_FAILURE`; `ENOENT`/`EACCES` → fixed configuration defect; host failure → `RETRYABLE_FAILURE` |
| No exit status is fabricated | `error.code` is overloaded — a number is a real child exit status, a string is a system error. Only a genuine numeric status becomes `EXITED`. `EMFILE`, `ENOMEM`, other system codes, a signal we did not send, and unreadable error properties all become `TRANSIENT_FAILURE` → `RETRYABLE`, never `PROBE_REJECTED` and never `PROBE_PROGRAM_UNAVAILABLE` |
| No raw output escapes | Malformed JSON and oversized output become fixed defects carrying none of the text; no signal name, system code or error message crosses the boundary |
| Classification is provable without a binary | `classifyProcessError` is a pure function driven by synthetic error objects — no subprocess, no `ffprobe`, no host condition to reproduce |

## Media policy

- MP4-family container required, read from the reported format list — **never** a
  filename or extension (the canonical key is extensionless).
- At least one **usable** video stream. `codec_type === "video"` is necessary but
  not sufficient: ffprobe reports embedded cover art as a video stream carrying
  `disposition.attached_pic`, usually with perfectly plausible dimensions.
  Embedded artwork is not customer video, so an audio-only M4A or podcast with
  album art and a positive container duration is `VIDEO_STREAM_MISSING`, not
  `VALID`. Attached pictures never count toward `videoStreamCount`, never become
  primary, and never supply the duration fallback; a real video that also carries
  artwork stays valid.
- The first listed **usable** video stream is primary, deterministically, however
  many other streams exist and in whatever order they are listed.
- Positive safe-integer width and height (numeric strings accepted, as ffprobe
  emits them).
- Positive finite duration → positive safe-integer milliseconds; container
  duration preferred, primary-video-stream duration a documented fallback.
- **Audio is optional** — `audioStreamCount` may be `0`.
- No codec restriction.
- **Dimensions are not compared to `targetOutputResolution`** — customer target
  and provider native generation resolution stay distinct.

## Inspection is not a decode guarantee

Stated in the ADR and the source: `ffprobe`/container validation **is not**
full-frame decode verification. Nothing here claims the output is "fully
playable". A bounded or full decode pass is deliberately deferred.

## Dormancy, as it now stands

Every real data-plane piece plus a media validator exists; production constructs
none of them.

| Claim | How it is held |
| --- | --- |
| No production construction of the validator or inspector | Static scan for `new S3ManagedOutputMediaValidator`, `new FfprobeMediaProbe`, `createDefaultProcessRunner(` |
| No production subprocess at all | Only the dormant inspector may mention `node:child_process`, `execFile`, `spawn(` or `ffprobe` |
| No production construction of the fal source, transfer core, S3 sink or `S3Client` | Unchanged scans |
| No credential wiring | `FAL_KEY`, AWS keys, `S3_BUCKET` absent from the environment schema |
| No runner/scheduler caller | Unchanged scans |
| No real network or binary in tests | Fake S3 reader and fake process runner; **CI needs no ffmpeg** |

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — all projects |
| `pnpm lint` | Pass — 0 problems |
| `pnpm test` | **4142 passed**, 124 files |
| `pnpm test:db` (live PostgreSQL) | **757 passed**, 23 files (unchanged — this phase adds no DB behavior) |
| `pnpm build` | Pass |
| Prisma drift | `No difference detected` |

**No migration, no schema change, no production `packages/database` change, and
no change to `OUTPUT_VERIFIED`.**

## Mutation ledger

**66 mutations, 66 killed, no survivors.** M01–M48 carry forward unchanged;
M49–M58 added by this phase, M59–M62 by the local-materialization integrity
correction, and M63–M65 by the media-verdict correctness correction:

| # | Defect | Killed by |
| --- | --- | --- |
| **M49** | Canonical receipt re-verification skipped before probing | digest/size mismatch tests |
| **M50** | Materialized size trusts `Content-Length` | actual-byte-authority tests |
| **M51** | Canonical object buffered whole before writing/probing | streaming/static no-buffer tests |
| **M52** | Media with no video stream accepted | media-policy tests |
| **M53** | Zero/missing/malformed duration accepted | duration tests |
| **M54** | Unsupported container accepted | container tests |
| **M55** | Caller/storage-derived data retained in the temp filename | temp-secrecy tests |
| **M56** | Inspector launched through a shell | static process-invocation tests |
| **M57** | Raw inspector output leaks from the malformed-output defect | leakage tests |
| **M58** | Temporary materialization not fully cleaned up | lifecycle tests |
| **M59** | One `write()` assumed to consume the whole chunk (`bytesWritten` ignored) | partial-write regression |
| **M60** | Zero/impossible write progress treated as success and skipped past | zero-progress regressions |
| **M61** | Failing success-path `close()` swallowed, probe runs anyway | close-failure regression |
| **M62** | Acquired canonical body abandoned uncancelled when the local open fails | open-failure-after-GET regression |
| **M63** | Embedded cover art counted as a usable video stream | attached-artwork regressions |
| **M64** | Cleanly observed zero-byte canonical object reported as retryable | zero-byte integrity regressions |
| **M65** | Non-numeric system/process failure fabricated into child exit 1 | process-classification regressions |

## Not done, on purpose

- **No lifecycle integration.** No runner call, no new durable state, no media
  columns, no migration, no quota/Scene-delivery/Job-readiness change.
- **No production activation.** No validator or inspector construction, no
  `S3Client`, no credentials, no scheduler, no real AWS/fal/ffprobe call.
- **No decode guarantee.** Container inspection only; a decode pass is deferred.
- **No resolution-contract change.** Media dimensions are recorded facts, not
  compared against `targetOutputResolution`.
