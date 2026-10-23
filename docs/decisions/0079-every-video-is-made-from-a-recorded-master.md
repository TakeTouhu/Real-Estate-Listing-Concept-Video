# ADR-0079 — Every video is made from a recorded master

Status: Accepted (DS-5b-2b-2, 2026-10-23). Part of the AI-generated disclosure
plan the product owner approved on 2026-10-20
(`/mnt/project-files/cto/disclosure-proposal.md`).
Completes: DS-5b-2b, the second half of what ADR-0078 began. ADR-0078's
Decision 6 and its note on `compose` named this milestone.
Builds on: ADR-0075 (the two encodes), ADR-0076 (the master's store and
inspector), ADR-0077 (Transaction J2's master record), ADR-0078 (the
master-first runner).

## Context

After DS-5b-2b-1 the runner makes or reuses the Clean Master, makes the
customer's video from the stored master and hands both receipts to
Transaction J2. Two things still allowed a video without a master, though
nothing used them: `FinalizeCompositionInput.cleanMaster` accepted `null`, and
J2 then recorded the video with no master's record; and the composer still
offered `compose`, the one-pass encode of the scenes into a video with no
disclosure. And the runner had run on fakes only: each adapter ran on real
FFmpeg or real files in its own suite, never all of them together.

## Decision 1 — The master's receipt is required

`FinalizeCompositionInput.cleanMaster` is a `CleanMasterReceipt`, never
`null`.

- **J2 refuses a finalize that names none**, with the new defect
  `CLEAN_MASTER_RECEIPT_MISSING`, before its transaction opens, so nothing is
  read, locked or written: a unit test runs it against a client that fails on
  any use. The type rules it out, so only an untyped caller can reach it; the
  check is there because a video recorded without its master is a deliverable
  no later disclosure change could be recomposed for (ADR-0052 Decision 17).
  The name is about the finalize's input; `CLEAN_MASTER_MISSING` (ADR-0078) is
  about what is stored.
- **Presence, not shape.** J2 checks that a receipt is there, not its fields,
  as it does for the video's: both are branded values only `sha256Digest` and
  `safePositiveByteCount` make. A malformed one from an untyped caller fails
  inside the transaction, on the master table's CHECK or before it, and the
  transaction rolls back with the video's receipt (the database suite holds
  that for the CHECK). Checking the fields again here would also stop that
  suite from proving the rollback.
- **Every first commit records the master**, at the key J2 rebuilds, as
  before.
- **A replay always compares a record.** A verified deliverable with no
  master's record was never finalized by this build: only one verified before
  profile v2 in a development database, or a record deleted by hand, can be
  one. A replay naming a master for it is `CLEAN_MASTER_RECEIPT_CONFLICT`, as
  before.
- A defect is a code only: no migration.

## Decision 2 — No encode of the scenes into a video

`compose` is removed from `DeliverableMediaComposer` and from the FFmpeg
composer, and its argument vector, `ffmpegComposeArgsFor`, from
`@app/storage`. The composer offers the master's encode and the disclosure's,
nothing else.

- The scenes' graph (ADR-0050's filter chain) is unchanged; it is now built
  only by `ffmpegCleanMasterArgsFor`, at `CLEAN_MASTER_CRF` whatever the
  profile's `crf`, which is the customer's video's.
- The unit suite pins that vector element by element, as it pinned
  `compose`'s, and requires the composer to offer exactly the two methods.

## Decision 3 — The runner end to end on real FFmpeg

A media suite (`tests/media/composition-runner.media.test.ts`) runs the runner
on the real scene materializer, Clean Master store, composer, Clean Master
inspector and video publisher. Three things are stand-ins: the object store, in
memory and first-wins as the S3 adapter's conditional create is; the temporary
files, the testing factory with no fault configured, which opens real files
exclusively at 0600 as production's does; and the repository, scripted, whose
claim carries profile v2 for 16:9 720p. It proves:

- **Fresh**: one master's encode, one inspection, one disclosure's encode; the
  stored master shows the scene where the disclosure's text goes and the
  stored video shows the text; both are 1280x720 at 30 fps, the scenes' length,
  with no audio; each receipt handed to J2 is the SHA-256 and size of the
  bytes at its key.
- **Another attempt's master**: with only a master stored (green, where the
  scenes are blue and red), no scene is read, no master is encoded, and the
  video is green: made from the stored master.
- **The video's store failing**: the attempt defers with
  `OUTPUT_PUBLISH_RETRYABLE` and leaves the master stored; the next reads no
  scene and encodes only the video, from that master.
- **A master of another size**: a stored 1920x1080 master is read by the real
  inspector and blocks with `CLEAN_MASTER_UNUSABLE`; no scene is read and no
  video made.
- **A stored video**: an attempt that lost its lease after storing both is
  followed by one that launches no program at all and hands J2 the same two
  receipts.
- **No temporary file survives** any attempt, and every file an attempt made,
  read or wrote was under the suite's own temporary root, so that check is
  not vacuous.

The suite builds nothing production runs: it constructs the runner in a test.

## Decision 4 — Still dormant, no migration

Nothing in production constructs the runner, its adapters or J2's caller. No
schema, enum or row changes. Rolling back to DS-5b-2b-1 is safe: that build
accepts every finalize this one makes.

---

## Consequences

- No path in the codebase makes a customer's video except from a stored,
  inspected Clean Master, and J2 records no video without its master.
- What composition does on real FFmpeg and real files is tested as one flow,
  including recovery after a failure and after a lost lease.
- DS-6 is next: publication requires the disclosure of the version's mode, a
  recorded Clean Master and measured facts that match the frozen profile.

Paid Provider Activation, production Provider credentials, production paid AI
calls, production scheduler activation and live Stripe charges remain BLOCKED.
Nothing here touches them.
