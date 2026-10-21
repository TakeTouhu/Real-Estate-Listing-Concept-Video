# ADR-0076 — Storing the Clean Master, and checking it before the disclosure

Status: Accepted (DS-5b-1, 2026-10-21). Part of the AI-generated disclosure plan
the product owner approved on 2026-10-20
(`/mnt/project-files/cto/disclosure-proposal.md`). Its DS-5 row is built in
three pull requests: DS-5a, the composer's two encodes (ADR-0075); DS-5b-1, the
master's store and its inspector (Decisions 1 to 4 here); and DS-5b-2,
composition running all of them (Decision 5, not built yet).
Implements: ADR-0075 Decision 6's master read back from its key, its ceiling,
and its size and rate checked before anything is laid over it. Builds on:
ADR-0074 (the master's internal key, which no signed URL reaches).

## Context

ADR-0071 Decision 7 has composition store the overlay-free Clean Master
(ADR-0052 Decision 17) and make the customer's video from the stored master's
bytes. ADR-0075 gave the composer the two encodes, and named what composition
still lacked: a way to store the master first-wins and read back what is
stored, a ceiling for it, and a check that the master is the profile's size and
frame rate, because `applyDisclosure` lays a frame-sized image at the origin and
nothing else would notice a master of another size. The customer's video's
publisher reads its key back for a receipt only; it keeps no copy, and nothing
read a video's frame rate.

## Decision 1 — A master is at most 1 GiB

`MAX_CLEAN_MASTER_BYTES` is 1 GiB, twice the customer's video's ceiling
(`MAX_DELIVERABLE_OUTPUT_BYTES`, 512 MiB). The master was measured at 1.1 to
1.5 times the video made from it (ADR-0075 Decision 1), so a master over 1 GiB
is the master of a video over 512 MiB, which could never be published anyway.
Like the video's, it is a machine-resource limit, not a product rule: what one
worker holds on disk and reads back, and what one master costs to keep. It is
enforced against the bytes read from the key, with the encoded file's size only
a preflight before it is sent.

## Decision 2 — The master's store copies back what is stored

`CleanMasterStore` (`createCleanMasterStore` in `@app/storage`) has three
methods, each against one master key:

| Method | Does | Answers |
| --- | --- | --- |
| `probe` | reads the key and hashes it, writing nothing | `ABSENT`, `STORED` with the receipt, `TOO_LARGE`, `RETRYABLE_FAILURE` |
| `fetch` | streams the stored master into a private file, hashing as it writes | `ABSENT`, `COPIED` with the copy, `TOO_LARGE`, `RETRYABLE_FAILURE` |
| `publish` | stores the encoded master first-wins, then copies back what is at the key | `COPIED`, `TOO_LARGE`, `RETRYABLE_FAILURE` |

- **The copy is of what is stored.** `publish` never keeps the file the master
  encode wrote: it stores it with a conditional create, then reads the key
  back. A key another attempt filled first keeps its master, and that master is
  what comes back, so every attempt lays the disclosure over the same stored
  bytes, and so does a later recomposition from the master (ADR-0071
  Decision 7).
- **One read, hashed as it is written.** Each method reads the key once. The
  receipt is the SHA-256 and byte count of the bytes streamed into the copy, so
  it describes exactly the file the composer will read; a chunk counts only
  once all of it is on disk, and a failing `close` (data still owed to the file)
  is a failed copy. Nothing is buffered whole in memory, and the read stops at
  the ceiling rather than after it.
- **Absent only when the store says so.** `ABSENT` is the store's own "no such
  key"; every other unreadable condition is retryable, since calling it absent
  would send composition to encode a master that may already exist. A
  zero-byte object is not a master and is retryable, as for the video: an
  operator may replace it. Absent straight after a successful write is
  retryable too.
- **Only the internal namespace is written.** The master carries no disclosure
  and is never the customer's, so `publish` refuses, as an internal error that
  names no key, any key that is not canonical or not under
  `org/{organizationId}/internal/`. The key's type already says so; the check
  holds when a cast does not.
- **The copy's directory holds the video too.** Each copy gets its own random
  directory under the system's temporary directory, prefixed `vta-master-`, with
  fixed names inside: `clean-master.mp4` for the copy and `output.mp4` for the
  customer's video, which the store names because it made the directory. One
  `release` removes both and may be called again; every failure path removes
  the directory before answering. No organization, job, version or key
  appears in either path.

## Decision 3 — The master is the profile's size and rate before anything is laid over it

`CleanMasterInspector` (`FfprobeCleanMasterInspector` in `@app/storage`) reads a
local master's frame size and frame rate, and `cleanMasterMatchesProfile`
(`@app/domain`) says whether they are the profile's:

- **The media validator's `ffprobe`, unchanged.** The same program, timeout,
  stdout ceiling and argument vector, through one function both inspectors now
  share, so they cannot disagree about what a timeout or a missing binary
  means: a timeout or a host failure is `RETRYABLE_FAILURE`; a missing binary,
  oversized output or malformed JSON throws the validator's fixed defects;
  `ffprobe` refusing the file is `UNUSABLE`.
- **The media policy decides first.** The file must pass the policy the
  customer's video is validated under (MP4-family, a usable video stream with
  real dimensions, a real duration), or it is `UNUSABLE`. The size is then the
  primary video stream's.
- **One constant rate, read exactly.** The frame rate is the primary video
  stream's `r_frame_rate`, as a reduced fraction of two positive integers, and
  only when its `avg_frame_rate` is the same fraction: a stream whose average
  differs from its base rate does not run at one constant rate. `0/0`
  (`ffprobe`'s "unknown"), a decimal, a sign, a space or a leading zero is no
  rate, and the master is `UNUSABLE`. Measured on FFmpeg 6.1.1, a composed
  master reports `30/1` for both, including for a length that is not a whole
  number of seconds.
- **Exact, with no tolerance.** The width and height must equal the profile's,
  and the rate equal it as a fraction (60/2 is 30/1). A raster is not a
  judgement: the inspector reports a wrong one as read, and the comparison
  refuses it.

The media suites prove both halves on real FFmpeg: every master and video the
composer makes, in all six sizes, is read as its profile's size and 30/1 and
matches it; masters encoded at 720p, portrait, two pixels narrower, 25 fps and
29.97 fps are read as they are and refused for the 1080p landscape profile;
and a PNG, a Matroska file and a text file are `UNUSABLE`.

## Decision 4 — Nothing calls them yet

DS-5b-1 adds the store, the inspector, the ceiling and the comparison, and
nothing calls them: the composition runner still claims under profile v1 and
calls `compose`, and nothing in production constructs the store or the
inspector (the dormancy tripwires now name both). The master's table is still
written and read by nothing. The DS-4 shape test now allows the store's port
and its adapter to name the master key's type; only the key module builds a
key. No migration.

---

## Decision 5 — How composition will run them (DS-5b-2, not built)

- **Composition profile v2** binds ADR-0075 Decision 1's master quality,
  Decision 2's overlay and layer v1. A build carrying it refuses a row frozen
  under v1, as `assertRunnableProfile` already does, and candidate discovery
  stops offering such rows, so none is claimed and refused forever.
- **The claim carries the version's disclosure mode and the master's key.**
- **The master before the video.** After the claim and its probe of the
  video's key: if the video is stored, `probe` the master and finalize with
  both receipts (a stored video without its master is a defect). Otherwise
  `fetch` the master; if it is absent, materialize the scenes, compose the
  master and `publish` it, releasing the scenes. Then inspect the copy, lay the
  disclosure over it (`applyDisclosure` with the claim's mode), publish the
  video, and finalize.
- **One record.** The transaction that records the video's receipt writes the
  Clean Master record in the same commit, and its replay compares both
  receipts.
- **Honest codes.** A master over its ceiling, and a master that is not the
  profile's size and rate, block the work with codes of their own (planned:
  `CLEAN_MASTER_SIZE_LIMIT_EXCEEDED`, `CLEAN_MASTER_UNUSABLE`, which need
  migration 31 to add two values to the block-code enum). The master's store
  failing defers with `OUTPUT_PUBLISH_RETRYABLE`, and the inspector failing
  with `COMPOSER_RETRYABLE`.
- **`compose` goes.** Nothing calls it once the runner runs the two encodes,
  and a method that makes a customer's video without its disclosure should not
  stay on the port.

---

## Consequences

- A composition can store its master once, first-wins, under the internal
  namespace, and lay the disclosure over a private copy of exactly the stored
  bytes, with the receipt of that copy.
- A master of another size or frame rate, or not a constant-rate MP4 video at
  all, is refused before the disclosure is laid over it.
- A master is at most 1 GiB. Once DS-5b-2 runs it, a worker encoding one holds
  the scenes (up to 2 GiB), the encoded master and its copy (up to 1 GiB each)
  at once, until the scenes are released.

Paid Provider Activation, production Provider credentials, production paid AI
calls, production scheduler activation and live Stripe charges remain BLOCKED.
Nothing here touches them.
