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

## The inspector subprocess

| Rule | How it is held |
| --- | --- |
| No shell, ever | `execFile` with `shell: false`; static tests ban `shell: true`, `exec(`, `execSync`, `spawnSync`, `/bin/sh` and template-string commands |
| Fixed argument vector | `-v error -of json -show_format -show_streams <app-created-path>`; the path is the only variable argument |
| Nothing tenant-shaped on the command line | Asserted: no bucket, key, `s3://`, `org/`, `generations/`, fal host, signature or `.mp4` |
| Bounded | Validated timeout (default 15s, ceiling 120s) and stdout cap (default 1 MiB, ceiling 8 MiB); stderr discarded |
| Availability ≠ invalidity | non-zero exit → `PROBE_REJECTED`; timeout → `RETRYABLE_FAILURE`; unlaunchable → fixed configuration defect |
| No raw output escapes | Malformed JSON and oversized output become fixed defects carrying none of the text |

## Media policy

- MP4-family container required, read from the reported format list — **never** a
  filename or extension (the canonical key is extensionless).
- At least one video stream; the first listed video stream is primary,
  deterministically, however many other streams exist.
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
| `pnpm test` | **4096 passed**, 124 files |
| `pnpm test:db` (live PostgreSQL) | **757 passed**, 23 files (unchanged — this phase adds no DB behavior) |
| `pnpm build` | Pass |
| Prisma drift | `No difference detected` |

**No migration, no schema change, no production `packages/database` change, and
no change to `OUTPUT_VERIFIED`.**

## Mutation ledger

**59 mutations, 59 killed, no survivors.** M01–M48 carry forward unchanged;
M49–M58 added:

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

## Not done, on purpose

- **No lifecycle integration.** No runner call, no new durable state, no media
  columns, no migration, no quota/Scene-delivery/Job-readiness change.
- **No production activation.** No validator or inspector construction, no
  `S3Client`, no credentials, no scheduler, no real AWS/fal/ffprobe call.
- **No decode guarantee.** Container inspection only; a decode pass is deferred.
- **No resolution-contract change.** Media dimensions are recorded facts, not
  compared against `targetOutputResolution`.
