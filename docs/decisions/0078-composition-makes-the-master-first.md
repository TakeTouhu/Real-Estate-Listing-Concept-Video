# ADR-0078 — Composition makes the Clean Master first

Status: Accepted (DS-5b-2b-1, 2026-10-23). Part of the AI-generated disclosure
plan the product owner approved on 2026-10-20
(`/mnt/project-files/cto/disclosure-proposal.md`).
Implements: the runner half of ADR-0076 Decision 5, on the records ADR-0077
made ready. DS-5b-2b-2 makes the master's receipt required, removes the
composer's one-pass `compose`, and runs the runner end to end on real FFmpeg.
Builds on: ADR-0050 (the runner, its claim, probe and finalize), ADR-0075 (the
two encodes), ADR-0076 (the master's store and inspector), ADR-0077 (the
claim's mode and master key, and J2's master record).

## Context

After DS-5b-2a every piece composition needs is built: the claim carries the
version's frozen disclosure mode and the master's internal key, Transaction J2
records a master receipt beside the video's, the store keeps a master
first-wins and copies back what is stored, the inspector reads its size and
rate, and the composer encodes the master and lays the disclosure over it. The
runner still ran profile v1: one encode of the scenes with no disclosure and
no master, finalized with `cleanMaster: null`. DS-5b-2b is split in two to stay
near the milestone size; this half switches the runner.

## Decision 1 — Composition profile v2

`COMPOSITION_PROFILE_KEY` is `vtavision-compose:v2`. v2 binds what v1 did not:
the master's quality (`CLEAN_MASTER_CRF`, ADR-0075 Decision 1), the overlay
(ADR-0075 Decision 2) and disclosure layer v1 (ADR-0071), so changing any of
them is a new profile, not an edit.

- **No migration.** The work row's frozen columns are the customer's video's
  settings, and those are v1's: the same raster table, CRF 18 (so the column's
  `crf = 18` check still holds), H.264, `yuv420p`. The master's CRF is the
  profile's, not a column. Nothing in the database constrains `profileKey`.
- **v1 work is refused and never offered.** The claim refuses a row frozen
  under another key (`assertRunnableProfile`) and discovery does not offer one
  (ADR-0077 Decision 4). Composition has never been activated, so such a row
  can exist only in a development database.

## Decision 2 — The master before the video

After the claim, its deterministic refusals and its probe of the video's key,
the runner does this:

| The video's key | The master's key | What the runner does |
| --- | --- | --- |
| stored | `probe`: stored | finalizes against both stored receipts, encoding nothing |
| absent | `fetch`: stored | inspects the copy, lays the disclosure over it, publishes the video, finalizes |
| absent | `fetch`: absent | materializes the scenes, encodes the master, `publish`es it, releases the scenes, then as above from the stored copy |

- **Always from the stored bytes.** `publish` is first-wins and copies back
  what is stored, so when another attempt stored the master first, this
  attempt's video is made from that master and records its receipt; the
  locally encoded file is discarded with the scenes. Every video is made from
  the master a later recomposition will read.
- **A stored master is reused, never encoded again.** An attempt that stored
  the master and then failed (the inspector, the overlay, the video's store,
  or J2) leaves the master at its key with no record; the next attempt fetches
  it instead of fetching the scenes. Recovery after the master is stored costs
  one download, not a second encode.
- **The disclosure is the version's.** `applyDisclosure` is given the claim's
  `disclosureMode`, frozen on the version (ADR-0073, ADR-0077 Decision 2).
- **Size and rate first.** The copy is inspected and compared with
  `cleanMasterMatchesProfile` before the disclosure is laid over it
  (ADR-0076 Decision 3).
- **What a worker holds.** The scenes and the encoded master go as soon as the
  master's store answers, before the video is made; the master's copy and the
  video go when the attempt ends. Each release runs on every path and a
  cleanup failure never replaces the attempt's answer, as for the scenes
  before.
- **The runner never calls `compose`**, the one-pass encode with no
  disclosure. It stays on the port only until DS-5b-2b-2 removes it.

## Decision 3 — Codes

| Answer | Outcome |
| --- | --- |
| the master's store: `TOO_LARGE` (probe, fetch or publish) | block `CLEAN_MASTER_SIZE_LIMIT_EXCEEDED` |
| the inspector: `UNUSABLE`, or a size or rate other than the profile's | block `CLEAN_MASTER_UNUSABLE` |
| the master's store: `RETRYABLE_FAILURE` | defer `OUTPUT_PUBLISH_RETRYABLE` |
| the inspector: `RETRYABLE_FAILURE` | defer `COMPOSER_RETRYABLE` |
| the master's encode or the overlay fails | defer `COMPOSER_RETRYABLE` |

The scenes' and the video's codes are unchanged. Both blocks are deterministic
because the stored master is never replaced: every later attempt reads the
same bytes (ADR-0077 Decision 1). An unreadable master key is never read as
absent, because that would encode a master that may already exist.

## Decision 4 — A stored video without its master is a defect

When the video's key holds bytes and the master's holds none, the runner throws
`CLEAN_MASTER_MISSING` and finalizes nothing.

- **Composition cannot produce this state.** It stores the master before it
  makes the video, and nothing deletes either.
- **Neither a block nor a fresh master.** A block code would give an
  impossible state a durable name. Encoding a master now would record one the
  stored video was not made from, which is the record ADR-0074 exists to rule
  out.
- **As every composition defect is handled.** The pass counts it as `failed`
  and carries on with the batch. The row keeps its lease, is offered again once
  the lease expires, and fails the same way until an operator repairs it
  (ADR-0052 Decision 20's recovery, unbuilt). It is a code only: no migration.

## Decision 5 — The master's proof instant

The receipt the runner hands J2 carries the instant the store answered for the
master's bytes: the clock read when `probe` found them stored, or when `fetch`
or `publish` returned the copy. On the composing path that is before the video
is made; the finalize's own `verifiedAt` stays the video's. J2 records each as
its own instant (ADR-0077 Decision 3).

## Decision 6 — Still dormant

Nothing in production constructs the runner, its store or its inspector, and
the dormancy tests still say so. `FinalizeCompositionInput.cleanMaster` keeps
`| null` until DS-5b-2b-2, which makes it required and has J2 refuse a missing
one; the runner already passes one on every finalize, and a shape test holds
that.

---

## Consequences

- Once composition is activated, every customer video is made from a stored,
  inspected Clean Master, carries its version's disclosure, and is finalized in
  the commit that records the master it was made from.
- A master over its ceiling or of the wrong size or rate stops the work with
  its own code, instead of producing a video.
- Two attempts at one deliverable converge on one master and one video;
  recovery after the master is stored never encodes it again.
- A stored video found without its master stops that deliverable as a defect
  until an operator acts.

Paid Provider Activation, production Provider credentials, production paid AI
calls, production scheduler activation and live Stripe charges remain BLOCKED.
Nothing here touches them.
