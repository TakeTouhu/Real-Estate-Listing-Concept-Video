# ADR-0044: Managed-output media validation is a separate, dormant capability that re-verifies the canonical bytes before inspecting them

- Status: Accepted
- Date: 2026-09-15
- Phase: 4C-3B-2H-3B-4
- Relates to: ADR-0041 (the streaming transfer core), ADR-0042 (the fal byte
  source), ADR-0043 (the durable S3 sink and its conditional publication),
  Phase 2H-1 (the managed-output integrity receipt authority), ADR-0031
  (application-owned error vocabulary, no external text)

## Context

The pipeline can now acquire a provider output, verify its bytes, and publish it
atomically to a canonical key. What it cannot do is say whether the object is
*media*. This phase adds that capability — and deliberately adds nothing else.

## Decision 1 — Byte integrity and media validity are different facts, and `OUTPUT_VERIFIED` keeps its meaning

`OUTPUT_VERIFIED` means, and continues to mean, exactly this:

> the canonical managed bytes were copied and byte-level integrity was verified.

It is **not** redefined to mean "playable video validated". A SHA-256 and a byte
count prove the object at the key is the object that was streamed; they say
nothing about container, streams or duration. Those are orthogonal questions, and
collapsing them would retroactively change what every already-`OUTPUT_VERIFIED`
row claimed.

So media validation is added as a capability **nothing calls**. No new durable
attempt state (`MEDIA_VERIFIED`, `OUTPUT_INVALID` or otherwise), no media fact
columns, no migration, no runner integration. Where media validity enters the
durable lifecycle is a separate state-machine decision that a later reviewed
phase will make, from a baseline where the capability already exists and is
proven.

## Decision 2 — The canonical bytes are re-hashed before anything is inspected

Validation re-reads the published object and compares it against the receipt the
transfer already computed. Only when **both** the SHA-256 and the byte count
match does any media inspection run; otherwise the answer is
`INTEGRITY_MISMATCH` and the inspector is never invoked.

Ordering matters. Byte integrity is the cheaper and stricter question, and
answering it first means a corrupted, truncated or replaced object is reported as
an integrity problem rather than handed to an inspector that might cheerfully
describe whatever it found. `INTEGRITY_MISMATCH` is a distinct outcome from
`INVALID_MEDIA` for the same reason: "this is not what we published" and "this is
not video" call for different responses.

The **actual streamed bytes are authoritative**. `Content-Length` is a preflight
ceiling only, an ETag is never an application hash, and custom S3 metadata is
never trusted — exactly as in ADR-0043.

## Decision 3 — Why S3 metadata, `Content-Type` and file extensions are insufficient

The canonical key is extensionless by design (Phase 2H-1), so there is no suffix
to read, and a suffix would prove nothing if there were. `Content-Type` is
whatever an uploader asserted; S3 metadata is whatever someone wrote; an `ftyp`
box at the head of the file proves only that the first few bytes look like an
MP4 header, not that the container is coherent or that a decodable video stream
exists. The validation authority is the actual canonical bytes plus real
container inspection — nothing declarative.

## Decision 4 — The bytes are materialized to a temporary file, not piped

MP4-family containers are not reliably inspectable from a forward-only stream:
the `moov` atom may sit at the end of the file, so an inspector needs to seek.
Rather than assume every provider emits faststart-optimized output, the validator
streams the object to a temporary file and inspects that. Streaming stays
incremental — the object is never buffered whole, never concatenated, never
turned into one array — and the hash and byte count are computed on the way past,
so materialization and verification are a single pass bounded by
`MAX_MANAGED_PROVIDER_OUTPUT_BYTES` (reused, never duplicated). An over-limit
object never reaches the inspector.

### Secure temporary file rules

- an application-created directory with a random, application-owned name;
- **no** organization id, attempt id, storage key, provider id or signed URL in
  any path component;
- a fixed filename, `input`, so even a process listing carries no tenant data;
- exclusive create with mode `0600` where the platform honours it;
- no caller-controlled path anywhere;
- removal of the file *and* its directory in a `finally`, on every exit path —
  valid, invalid, mismatch, retry, or an unexpected defect;
- cleanup failure is best effort and never replaces the primary outcome;
- no temporary path appears in any domain result or persisted state.

## Decision 5 — The inspector subprocess boundary

`ffprobe` is invoked through `execFile` with `shell: false`. There is **no
command string anywhere** — nothing is interpolated, quoted or escaped, because
nothing is parsed by a shell. The argument vector is fixed:

```text
ffprobe -v error -of json -show_format -show_streams <app-created-temp-path>
```

The only variable argument is the path this process created. A bucket, key,
provider URL, signed location or customer filename is never passed. The program
path is injectable for a future composition; no environment variable is added
this phase.

### Bounds

A validated timeout (default 15s, hard ceiling 120s) and a validated stdout cap
(default 1 MiB, hard ceiling 8 MiB). Output beyond the cap terminates the process
rather than accumulating; a timeout kills it; stderr is discarded rather than
captured into anything that could be surfaced.

### Availability is not invalidity

Three different things are deliberately not conflated:

```text
runs and exits non-zero  → INVALID_MEDIA / PROBE_REJECTED   (about the file)
times out                → RETRYABLE_FAILURE                 (about neither)
cannot be launched       → fixed configuration defect        (about the deployment)
```

A missing or unusable binary must never be reported as a customer's broken video.
Every property read from a caught process error is guarded, and no external
message is ever propagated.

## Decision 6 — Only normalized facts cross the boundary

Raw ffprobe JSON is infrastructure-local and never leaves the adapter. A
successful validation reports exactly: container family (`ISO_BMFF`), a positive
safe-integer `durationMs`, positive safe-integer primary video width and height,
and normalized video and audio stream counts. No `format_name`, codec prose,
filename, temp path, bucket, key, AWS metadata, command string or process output.

Policy notes:

- **Container** comes from the reported format list, never a filename.
- **Primary video** is the first stream ffprobe lists whose `codec_type` is
  `video`, deterministically, however many other streams exist.
- **Duration** prefers the container's own duration; a primary-video-stream
  duration is an accepted, documented fallback, because a valid MP4 can carry
  duration on the track when the format entry is absent. Zero, negative, NaN,
  Infinity, malformed and absent durations are all invalid.
- **Audio is optional.** `audioStreamCount` may be `0`; a generated walkthrough
  with no audio track is valid media, and requiring audio would encode a product
  rule this phase has no authority to make.
- **No codec restriction** is imposed yet.
- **Dimensions are facts, not a contract check.** They are deliberately not
  compared against `targetOutputResolution`: this repository distinguishes the
  customer's target output resolution from the provider's native generation
  resolution, and conflating them would invent a rule neither states.

The port returns `unknown`, and a total, materializing parser is the single
authority on the result: every property is read once, under a guard, into a fresh
plain object, so a hostile or stateful adapter value cannot pass validation and
then change under the caller.

## Decision 7 — Container inspection is not a decode guarantee

Stated plainly, because it is easy to overclaim:

```text
ffprobe / container validation != full-frame decode verification.
```

`ffprobe` reads container metadata and stream headers. It does not decode every
frame, and a file it describes happily can still contain corrupt pictures.
Nothing in this phase may be described as proving the output is "fully playable".
A later reviewed phase may add a bounded or complete decode pass, or validate at
composition time, if the product needs that guarantee.

## Why this phase remains dormant

Nothing in production constructs the validator or the inspector, no production
code performs a media-validation read, no production process is launched, no
runner or scheduler calls any of it, there is no `FAL_KEY` and no AWS credential
wiring, and no test makes a real fal, AWS or `ffprobe` call — CI needs no ffmpeg
binary. The static suite asserts each.

## Consequences

- The repository now contains every real data-plane piece plus a media validator,
  all uncomposed. Activating any of it remains a later, explicit CTO phase.
- A future change that skips receipt re-verification, trusts `Content-Length` or
  an ETag, buffers the object whole, accepts media with no video stream, accepts
  an invalid duration or unsupported container, leaks storage-derived data into a
  temp filename or result, shells out, leaks inspector output, or fails to clean
  up on an exit path is caught by the mutation ledger (M49–M58).
- `OUTPUT_VERIFIED` is unchanged, so no existing row's meaning moved.
