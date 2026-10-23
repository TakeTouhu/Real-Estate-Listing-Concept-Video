# ADR-0080 — Publication requires the version's disclosure and its Clean Master

Status: Accepted (DS-6a, 2026-10-23). Part of the AI-generated disclosure
plan the product owner approved on 2026-10-20
(`/mnt/project-files/cto/disclosure-proposal.md`).
Implements: the first half of DS-6. DS-6b adds the second: the measured video
must be the planned size and length.
Builds on: ADR-0051 (Transaction G), ADR-0073 (the mode on each version),
ADR-0077 (J2 records the master), ADR-0078 (profile v2 draws the version's
mode), ADR-0079 (no video without a recorded master).

## Context

Since DS-5b-2b-2 no code path makes a customer's video except from a stored,
inspected Clean Master, with the disclosure of the version's mode drawn over
it, and Transaction J2 records no video without its master. Transaction G, the
commit that makes a validated video the customer's and spends their Unit,
still checked neither. A version composed by an earlier build, or a row
altered by hand, would have been published with no disclosure, or with no
master for a later disclosure change to be recomposed from (ADR-0052
Decisions 8 and 17).

The plan's line reads "the disclosure of the job's mode". A job's versions can
differ in mode once disclosure changes exist, each change being its own
version (ADR-0073 Decision 3), so what the customer's video must carry is the
mode of the version being published. This ADR reads the plan that way, as
ADR-0079 already did.

## Decision 1 — The composition drew the version's disclosure

Transaction G publishes a version only when its composition's frozen profile
is one that drew that version's mode: `profileDrewDisclosure(profileKey,
mode)`, true for `vtavision-compose:v2` and a mode this build knows, false for
v1 (which drew none), for any other key and for any other mode. Otherwise it
throws the defect `DISCLOSURE_NOT_DRAWN`.

- **The evidence is the frozen profile, not the frames.** Nothing reads the
  video here: Transaction G holds the entitlement lock and never touches
  storage (ADR-0051). v2 draws the version's mode over every video it makes,
  from the stored master (ADR-0078), and the media suites prove the drawing.
- **The version's mode, read under the version's lock**, never the job's or
  today's default.

## Decision 2 — The version's Clean Master is recorded

Transaction G publishes a version only when its
`generation_deliverable_clean_masters` row exists at the key J2 records it at,
`org/{organizationId}/internal/clean-masters/{deliverableVersionId}`, rebuilt
from the version's own organization. Otherwise it throws the defect
`CLEAN_MASTER_NOT_RECORDED`.

- The table's CHECK fixes the key's shape and its version, not its
  organization, so the organization is compared here.
- The row is read in the chain's query and not locked: it has no update path,
  and nothing in this build deletes one.
- Nothing reads the master's bytes. J2 recorded the receipt of what it stored,
  and the composition runner inspected those bytes (ADR-0078).

## Decision 3 — Where the gate stands

After everything that makes the call an ordinary `NOT_PUBLISHABLE` or a
replay, and before the publication's kind is decided:

1. A replay is answered `ALREADY_PUBLISHED` and judged no further: it writes
   nothing, so there is nothing to stop.
2. A job that moved on, a verdict that is not the named row and a pointer that
   would move backwards stay `NOT_PUBLISHABLE`, whatever the version carries.
3. Then the gate, for an initial publication and a replacement alike: a
   replacement must not take a disclosed video from the customer and give
   them one without.

## Decision 4 — Defects, not outcomes

Both refusals are defects, as Transaction G's other refusals of states this
build cannot produce are. This build composes only under v2 and J2 records the
master in the receipt's commit, so only a version composed before DS-5b-2b-1,
in a development database, or a row altered by hand can fail either. The
transaction rolls back: no pointer, no spent Unit, no event, and the `VALID`
verdict stays. The row is offered again on every pass, as for Transaction G's
other defects, until an operator acts (ADR-0052 Decision 20's recovery,
unbuilt; `docs/decisions/TODO.md`).

A video of the wrong size or length is different: the composer can produce
one, so DS-6b makes it a verdict, not a defect.

## Decision 5 — One refused deliverable does not stop the sweep

The validation runner's `runOnce` did not isolate its candidates: a defect
thrown for one ended the pass. Discovery offers a `VALID` row awaiting
publication first on every pass (it is ordered by when it was validated), so
one row Transaction G refuses would have stopped every other deliverable from
ever being published. `runOnce` now isolates each candidate, as composition's
sweep does (ADR-0050): a thrown error becomes that candidate's
`{ kind: "FAILED", code }` outcome, where `code` is the defect's code when it
was one of this module's defects and `null` otherwise, and the sweep goes on.
Nothing else about the error is kept. `FAILED` is not counted as claimed.
`runOne` still throws, unchanged, to a caller that asked about one
deliverable.

## Decision 6 — Dormant, no migration

Nothing in production constructs the validation runner or calls Transaction G.
No schema, enum or row changes: a defect is a code. Rolling back to
DS-5b-2b-2's build is safe: it publishes everything this build publishes, and
also what this build refuses, which this build cannot make.

---

## Consequences

- No video reaches a customer's workspace unless the composition that made it
  drew its version's disclosure and its Clean Master is recorded.
- A development database holding a verified v1 composition, or a version
  without a master, now raises a defect at publication; the migration notes
  give the query to find them. The sweep reports it and publishes the rest.
- DS-6b is next: the measured video must be the frozen profile's size and the
  plan's length.

Paid Provider Activation, production Provider credentials, production paid AI
calls, production scheduler activation and live Stripe charges remain BLOCKED.
Nothing here touches them.
