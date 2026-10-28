# Gap analysis — starting a video, and previewing and downloading it

Base: `main @ dbe8038` (PR #104, DS-6b; post-merge CI run 666 green).
Plan: `/mnt/project-files/cto/generation-e2e-proposal.md`, approved by the
product owner on 2026-10-26, including the development-only pipeline command.
Each pull request still needs the product owner's yes before merge.

## What the plan must reach

A person on a development machine, with the test provider and no paid call,
can: sign in → open a Property → upload → approve photos → compose the
storyboard → **start a video (Normal or HQ)** → have it generated, composed
with the disclosure and validated → **preview and download it**. And when no
valid video is delivered, the reserved Unit is released (ADR-0052 Decision 19).

## What is implemented on the base

| Step | State on `dbe8038` | Where |
| --- | --- | --- |
| Unit reservation (eligibility-first, quality-locked, HQ ceiling) | built, dormant | `orchestration-repositories.ts` `reserve`; ADR-0055 |
| Scene output copy, scene validation and delivery | built, dormant | Phases 4C-3B-2H, ADR-0038 to ADR-0046 |
| Composition plan, composition with the Clean Master and the disclosure, final validation, Transaction G | built, dormant | ADR-0049 to ADR-0051, ADR-0071 to ADR-0081 |
| Settlement of a scene's exhausted media failure | built, dormant | `media-failure-resolution-repository.ts`; ADR-0048 |
| **Settlement of a failed deliverable** (`BLOCKED`, `INVALID_MEDIA`, `INTEGRITY_MISMATCH`) | **missing**: the job stays `COMPOSING` or `DELIVERABLE_VALIDATING` and an initial generation's reservation `RESERVED` forever | `blockComposition`, `finalizeTerminalVerdict` |
| Settlement of a provider refusal, a provider failure, an unresolved submission | **missing** | submission and reconciliation repositories |
| A start step for a whole video (job, reservation, scenes; the first attempts once the job may run) | **missing**; only a single-scene admission exists, and nothing calls it | `generation` domain |
| Sending work to a provider and recording the answer | **missing** | |
| A test provider that produces video bytes | **missing**: the fake answers "succeeded" with no bytes, and has no catalog, route or price entry (*route, price and catalog since GS-5a-2; real clips since GS-6, ADR-0092*) | `video-providers` |
| Storage shared by the web app and the worker | **missing**: uploads live in process memory | `@app/storage` |
| Anything that runs the steps | **none, by design** (ADR-0054 Decision 7) | static dormancy tests |
| Start screen, progress, preview, download | **none** | `apps/web` |
| Concurrent-job limit (1 / 3 / 5) | **not enforced** | |

## The milestones

The plan's thirteen pull requests, in four stages: A, the money rule (GS-1,
GS-2); B, the engine (GS-3 to GS-9); C, the screens (GS-10 to GS-12); D, the
end-to-end proof (GS-13). Each is split further where it would exceed about
500 changed lines.

## GS-1 — a failed deliverable settles its job

The first gap closed. A composition `BLOCKED` and a terminal non-`VALID`
verdict now settle in their own commit: an initial generation fails and its
Unit is released; a replacement returns to the video the customer already
holds. The plan expected a migration here; none was needed, because every
state and column already exists (ADR-0082).

Deliberately left to later milestones or decisions: provider-side failures
(GS-2), Transaction G's defects, a claim refused as `UNSUPPORTED_TARGET`, the
reservation of a paid regeneration or charged disclosure change (not built),
and operator recovery (ADR-0052 Decision 20). All are recorded in
`docs/decisions/TODO.md`.

## GS-2a — a scene whose attempts ended without a video settles its job

The second gap, split in two. GS-2a settles a scene request whose attempts all
ended, the newest without a video (a refusal, a provider failure or an
unresolved submission): an initial
generation fails and its Unit is released; a scene regeneration returns to the
video the customer already holds. It is a bounded sweep, Transaction K, rather
than a change to each writer, because the failure is already a durable fact and
one transaction with one lock order is reviewable where a change to every writer
is not (ADR-0083 Decision 1). No
migration.

GS-2b ends the failed job's other scenes and cancels their queued attempts,
for this settlement and Transaction H alike. Also left open: an attempt that
never ends (a provider that never answers, an output copy that keeps failing),
an attempt that fails preflight (the preflight writes the legacy `state` column,
not the orchestration state), a job still `RESERVED` (the start step leaves it so until GS-7's launch
step admits its first attempts; see GS-4 below), and the internal
service-recovery budget, which may later retry a failed attempt before it
settles. All are recorded in `docs/decisions/TODO.md`.

## GS-2b — a failed job's other scenes close

The rest of the second gap. A job fails with the first scene that settles, and
its other scenes stayed open: some never started, some held an attempt waiting
to be sent that the paid-submission gate refuses once the Unit is released, some
an attempt at the provider. GS-2b closes each with a bounded sweep, Transaction
L, once nothing of it is at the provider, for Transactions H and K alike
(ADR-0084). A scene waiting on an attempt the provider holds closes after that
attempt ends. No migration.

Left open: a cancelled job's open scenes (nothing cancels a job today), an
attempt that never ends, which keeps its scene open, which executor runs
orchestrated attempts and that the legacy discovery stops offering them (GS-7),
and starting each scene with its first admission, which
Transaction K assumes (GS-7's launch step; see GS-4 below). Recorded in ADR-0084 and `docs/decisions/TODO.md`.

## GS-3 — a shared folder holds development and CI objects

The storage gap. The web app kept uploads in its own memory, which the worker
cannot read and a restart loses. GS-3 adds one folder on disk that both
processes open, with the web app's `ObjectStorage` port and the worker's
S3-shaped seam over the same objects, so every existing caller runs unchanged
(ADR-0085). The web app uses it when `SHARED_STORAGE_DIR` is set. Refused in
production. No migration.

Left open: the worker opening it (GS-9); serving the customer's video from it,
since the download route reads a whole object into memory and has no content
type for a deliverable's key (GS-12); and removing what a killed process leaves
in it. Recorded in ADR-0085 and `docs/decisions/TODO.md`.

## GS-4 — the whole-video start step

The start gap. Nothing starts a whole video. On `b9513aa` the pieces exist as
separate repository methods, each its own commit: create the job, move it to
`RESERVING`, reserve its Units, create each scene, create each scene's first
request. The plan needs them as one commit, so that a failure leaves nothing
behind and a short balance writes nothing. Four more gaps sit around them:

| Gap | On the base |
| --- | --- |
| Pressing start twice must start one job | No job carries an idempotency key, though `docs/DataModel.md` lists one and `docs/API.md` requires `Idempotency-Key` for generation commands |
| The storyboard must be current when its scenes are copied | Freshness is derived (ADR-0012), but `compose` saved the scenes and the fingerprint in two commits, so two racing compositions could leave one's scenes under the other's fingerprint, reading as current |
| Quality comes from the project's resolution (the approved plan's first default) | The job takes a caller-supplied quality tier |
| The start step's checks: permissions, reach, Mode A, the Unit period | Built as separate rules (`video.generate`, `unit.consume`, ADR-0064 reach, ADR-0073, period opening) with no caller that combines them |

Split into three pull requests:

- **GS-4a** (ADR-0086, no migration): a storyboard's scenes, status and
  fingerprint are saved in one commit, after locking the project row.
- **GS-4b** (ADR-0087, migration 32): the start commit in the database. Under
  the project row, held `FOR SHARE`, it confirms the storyboard the service
  judged current is still the project's, then creates the job, reserves its
  Units, copies its scenes and their first requests, and records the audit
  entry; or it writes nothing. A start key, unique per project, makes a replay
  answer with the job it started.
- **GS-4c** (ADR-0088, no migration): the start service in the domain:
  `video.generate` and `unit.consume`, reach, the start key, the storyboard's
  freshness, quality from the project's resolution, Mode A, opening the Unit
  period first, and the outcomes the start screen (GS-10) will show. Three
  gaps the commit did not cover are closed here: the customer confirms the
  scenes as well as the quality, by their ids, since the fingerprint stays
  internal; a quality no verified route serves (HQ, today) is refused before
  Units are reserved; and a deleted Property's project, whose photos cannot be
  generated from, does not start.

The start step leaves the job `RESERVED`, with its scenes and requests
`PENDING`. It admits no attempt. The approved plan's start step creates the
job, reserves the Units and creates the scenes in one commit (Design 2), and an
organization runs at most 1, 3 or 5 jobs at once, extra jobs waiting with their
Units reserved and starting oldest first (Design 6, from ADR-0052 Decision 7).
So the first attempts are admitted when the job may run, by GS-7's launch
step, which also starts each scene in that commit, the shape Transactions K
and L expect (ADR-0083 Decision 3). An attempt also needs a route and a price,
which GS-5 supplies.

Until GS-7 nothing launches a job, and until GS-10 nothing constructs the start
service, so no job can be left waiting. A job that waits must still never hold
its Unit indefinitely (ADR-0052 Decision 19): GS-7 decides what releases one
that can never launch (`docs/decisions/TODO.md`).

## GS-5 — the test route, and a cycle's revenue

The paid-submission gap. An attempt crosses into `SUBMITTING` only through the
paid-submission gate, and on `90f0be6` the gate refuses every attempt a
development start could make:

| Gap | On the base |
| --- | --- |
| The test provider has no route | `authorizeRoute` reads production's route table, a module constant, and the test provider is not in it |
| HQ has no route anywhere | `AUTHORIZED_QUALITY_TIERS` is Normal only, and the start's offer (ADR-0088) reads the same constant |
| The test provider has no price | The paid-submission repository verifies snapshots against production's price catalog, called inside it |
| The test provider has no catalog entry | `createVideoModelCatalog()` lists four production models; its default has no adapter |
| No exchange rate | A snapshot priced in US dollars needs an FX snapshot, and no production process makes one |
| No cycle revenue | The revenue reader returns `null`, so the Safety Guard hard-pauses every attempt; no ADR defines what a cycle's revenue is |

Split into pull requests:

- **GS-5a-1** (ADR-0089, no migration): the route table and the price catalog
  are passed in, production's when nothing is: `RoutePolicy`, the gate and the
  start's quality offer against the same policy, and the repository's
  catalog. Production behaves as before.
- **GS-5a-2** (ADR-0090, no migration): the test route's catalog entry, route
  (Normal at 720p and HQ at 1080p), price and fixed FX rate, built only by
  `createFakeRouteKit`, which refuses production. Nothing builds it until
  GS-9.
- **GS-5b** (ADR-0091, no migration): the billing cycle's revenue reader.
  The product owner decided on 2026-10-27 what revenue is: the plan's monthly
  price plus the period's Unit purchases, tax-exclusive
  (`docs/decisions/TODO.md`, decision gates closed). It is read from the
  cycle's entitlement period; Enterprise stays unknown.

## GS-6 — the test provider's clips

On `22f7099` the fake provider accepts a request and answers its status with a
made-up address and no bytes, so nothing after submission can run on it: the
provider-output runner needs a status source and a byte source, and the fake
has neither. Its catalog entry (GS-5a-2) records clips at 720p and 1080p that
nothing makes.

GS-6 (ADR-0092, no migration) adds the fake's studio: it makes a real clip
from the scene's photo, read through the signed URL as a provider reads it,
at the request's native frame and length, and its status source and byte
source hand the clip to the transfer core. Nothing composes them until GS-9.
