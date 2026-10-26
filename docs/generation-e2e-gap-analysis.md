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
| A start step for a whole video (job, reservation, scenes, first attempts) | **missing**; only a single-scene admission exists, and nothing calls it | `generation` domain |
| Sending work to a provider and recording the answer | **missing** | |
| A test provider that produces video bytes | **missing**: the fake answers "succeeded" with no bytes, and has no catalog, route or price entry | `video-providers` |
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
not the orchestration state), a job still `RESERVED` (GS-4's start step leaves none), and the internal
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
and the start step starting each scene with its first admission, which
Transaction K assumes (GS-4). Recorded in ADR-0084 and `docs/decisions/TODO.md`.
