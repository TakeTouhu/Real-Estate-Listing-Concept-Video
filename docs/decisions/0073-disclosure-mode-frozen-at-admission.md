# ADR-0073 — The disclosure mode, frozen at admission

Status: Accepted (DS-3, 2026-10-20). Part of the AI-generated disclosure plan
the product owner approved on 2026-10-20
(`/mnt/project-files/cto/disclosure-proposal.md`).
Implements: ADR-0052 Decision 10, *Mode C conditions are frozen at generation
admission*, for the mode itself, and Decision 8's default, Mode A. ADR-0052
chooses no schema field names; this ADR chooses them.
Amends: ADR-0049 Decision 6 (the input fingerprint becomes v2 and binds the
mode) and Decision 11 (a replay recomputes under the version's own mode).

## Context

ADR-0052 Decision 10 makes a generation's disclosure mode part of what is
admitted: it is evaluated once, when the generation is admitted, and the job
keeps it through completion and delivery, with no pre-delivery re-check and no
automatic fallback. Later organization or permission changes affect only newly
admitted generations, and a later disclosure-mode change is its own admission.

Nothing stored a mode. The generation job froze its output resolution, aspect
ratio and duration at creation, and the composition plan (ADR-0049) bound those
three into each deliverable version's input fingerprint, but a version planned
with the disclosure and one planned without it would have had the same
fingerprint.

DS-5 will lay the disclosure over the video and DS-6 will refuse to publish a
deliverable without the disclosure its mode requires. Both need the mode on the
rows they read before either is built.

## Decision 1 — One enum, Mode A only

Migration 29 creates the PostgreSQL enum `DisclosureMode` with one value,
`THROUGHOUT`: ADR-0052's Mode A, the disclosure for the whole video.
`@app/domain` holds the same list (`DISCLOSURE_MODES`), its default
(`DEFAULT_DISCLOSURE_MODE`, Mode A) and a guard (`isDisclosureMode`), and a
test compares the domain's list with the schema's and the migration's.

| ADR-0052 | Stored | What the customer's video shows |
| --- | --- | --- |
| Mode A, the default | `THROUGHOUT` | the disclosure for the whole video |
| Mode B | not yet stored | the disclosure for the first and last 2 seconds |
| Mode C | not yet stored | no disclosure (ADR-0052 spells its evidence `NONE`) |

Mode B and Mode C each come with their own rules, Mode C with its three gates
and its consent evidence. Each adds its value to the enum and to the domain's
list in the pull request that builds it. Until then nothing can store them, and
admission cannot accept them.

The stored values name what the video shows rather than the letters, so a stored
row reads without the ADR beside it.

## Decision 2 — Frozen on the job, at admission

`generation_jobs.disclosureMode` is `NOT NULL` with no database default.

- **Every caller names it.** `NewGenerationJob.disclosureMode` is required, and
  the repository supplies no default. The admission that offers the customer a
  choice applies ADR-0052's default itself, so a missing mode is a type error,
  not Mode A by accident.
- **A mode not built is refused before anything is written.** The repository
  checks `isDisclosureMode` before its transaction opens and answers
  `DISCLOSURE_MODE_NOT_SUPPORTED`, as it answers `DURATION_NOT_SUPPORTED` for a
  duration the product does not sell. TypeScript already refuses such a value;
  the check covers a caller that is not type-checked.
- **Never updated.** No repository writes the column after the job's creation,
  and a test reads the repositories' source to hold that. No database trigger
  enforces it: ADR-0038 keeps such rules in the repositories.

No route admits a whole-video generation yet, so no customer chooses a mode
today. The generation-start screen, proposed separately, offers Mode A only
until Mode B and Mode C are built.

## Decision 3 — Copied onto each deliverable version

`generation_deliverable_versions.disclosureMode` is `NOT NULL` with no default.
Transaction I (ADR-0049 Decision 7) copies the locked job's mode onto the
version it plans, in the same commit.

The mode is stored per version, not read from the job when composing, because
a later disclosure change is its own admission and its own version (ADR-0052
Decision 10). A job's versions can then differ in mode, and each version
records the one it was planned and will be delivered under. Today every version
takes its job's mode, because nothing changes a mode yet. Which mode a version
planned after a disclosure change should carry when a content regeneration
follows it is not decided here; it is recorded in `docs/decisions/TODO.md`.

## Decision 4 — The input fingerprint is v2 and binds the mode

`computeDeliverableInputFingerprint` hashes the target as four elements,
`[targetOutputResolution, targetAspectRatio, requestedDurationSeconds,
disclosureMode]`, under the prefix `sha256:deliverable-input:v2`. The scenes'
tuples are unchanged. The same ordered scene bytes with and without the
disclosure are different deliverables, so their fingerprints differ.

A replay (ADR-0049 Decision 11) recomputes with **the version's own mode**, not
the job's, so the fingerprint witnesses what the version was planned under.

**A v1 fingerprint is never rewritten.** A version planned before migration 29
keeps its `sha256:deliverable-input:v1` value. Only Transaction I's replay
recomputes a fingerprint, and only for the pending version: replayed, a v1 plan
no longer matches, and Transaction I raises `PARTIAL_PLAN_STATE`, as for any
plan whose fingerprint no longer describes its own rows. Composition's claim
and finalization (ADR-0050) do not read the fingerprint, so a pending v1 plan is
still claimed and composed as before. A v1 version that is already a job's
current deliverable is never recomputed; a later recomposition plans a new v2
version beside it. Only development databases hold a v1 version: the pipeline
after admission is dormant and nothing has been delivered.

## Decision 5 — Existing rows are Mode A

Migration 29 adds each column with `DEFAULT 'THROUGHOUT'`, so existing rows are
Mode A, then drops the default in the same migration. The approved plan records
development jobs from before DS-3 as Mode A. No composition draws the disclosure
until DS-5, so a version composed before then holds a video without it although
its row says Mode A; DS-6 will refuse to publish a deliverable without a Clean
Master, which no such version has. Only development data holds one. The
migration updates no row itself and creates no table, index or constraint.

## Decision 6 — Nothing else changes

- No state, transition or event changes. The transition metadata allowlist is
  unchanged, so the mode is not copied into events.
- The composition claim, the composer and publication do not read the mode yet.
  DS-5 lays the disclosure over the video for the version's mode, and DS-6
  refuses to publish one without it.
- No route, page, export, command, environment variable or dependency.

---

## Consequences

- Every job and every deliverable version records the disclosure mode it was
  admitted and planned under, and nothing can store a mode that is not built.
- Mode B and Mode C each add one enum value, in the domain list and the database
  together, with their own admission rules.
- Transaction I's replay of a plan stored before migration 29 fails closed;
  composition does not read the fingerprint and is unaffected. Only development
  data holds such a plan.
- The question of which mode a later version carries is open until disclosure
  changes are built.
