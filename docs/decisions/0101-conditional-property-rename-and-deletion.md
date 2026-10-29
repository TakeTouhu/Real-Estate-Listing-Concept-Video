# ADR-0101 — A Property's rename and deletion are conditional writes

Status: Accepted (2026-10-29). The product owner chose "直す" on the decision
card of 2026-10-29 08:14Z, asking whether to fix, in a pull request of its own,
a Property rename that can undo the Property's deletion. Found by GS-7d-2's
review (`docs/decisions/TODO.md`, *Make a Property's rename and deletion
conditional writes*).
Builds on: ADR-0052 Decision 17 (a deleted Property's content goes to the
trash), ADR-0064 (a deleted Property refuses new work), ADR-0096, ADR-0099 and
ADR-0100 (each holds a Property `FOR SHARE` and reads its deletion).

## Context

`PropertyService.update` read the Property, then wrote the whole row back
through `PropertyRepository.update`, by id alone, every field from its read
included, `status` among them. `PropertyService.remove` did the same with
`status: "DELETED"`. So:

- a rename that read the Property before a deletion saved wrote `ACTIVE` back
  after it. The Property reappeared, while its photos stayed asked to be
  deleted, and the endings of ADR-0099 and ADR-0100 read it standing;
- a deletion that read the Property before a rename saved wrote the old name
  back;
- two renames of different fields lost one of them;
- two deletions both succeeded and wrote two audit entries.

The photos' own writes had the same defect and were fixed the same way
(`MediaAssetRepository.updateIfCurrent`).

No HTTP route renames or deletes a Property today: nothing outside tests calls
`PropertyService.update` or `remove`. So no customer has met this; the fix lands
before a route does.

## Decision 1 — A rename writes the fields it names, while the Property stands

`PropertyRepository.updateDetails(organizationId, id, change)` writes only the
fields `change` names (name, type, masked address, description), and
`updatedAt` by `@updatedAt`, in one `UPDATE … RETURNING` whose condition is
the id, the organization and a status other than `DELETED`, as the photos'
`updateIfCurrent` does (Prisma 5.22 compiles the extra filters into the
statement's `WHERE`; checked against PostgreSQL). It never writes the status
or the assignments. `null` means no such Property in the organization, or a
deleted one (Prisma's `P2025`); nothing was written.

`PropertyService.update` passes only the fields the member sent, after the same
validation as before, and answers `null` as `NOT_FOUND`, the answer its own
read gives a deleted Property, with no audit entry.

A change naming no field writes nothing: Prisma reads the row under the same
condition, and the Property is answered, or `null`.

## Decision 2 — A deletion writes the status alone, once

`PropertyRepository.markDeleted(organizationId, id)` writes `status: DELETED`
alone (and `updatedAt`, by `@updatedAt`), in one `updateMany` on the id, the
organization and a status other than `DELETED`. `false` means no such
Property in the organization, or another deletion saved first.

`PropertyService.remove` answers `false` as `NOT_FOUND`, as the next request
would be answered, before asking for any photo's deletion and with no audit
entry: the deletion that saved first does both. A deletion is still one
statement, as ADR-0096, ADR-0099 and ADR-0100 rely on: each waits for it under
its Property `FOR SHARE`, and then reads it.

## Decision 3 — The unconditional write is gone

`PropertyRepository.update(property)` is removed, so no caller can write a
Property from a snapshot. The in-memory repository implements the two new
methods with the same conditions.

## Not decided here

- **A rename or a deletion racing a reassignment** that takes the Property
  out of the member's reach: reach is checked at the read, as for every
  Property action (ADR-0064), so either still saves; the reassignment is
  itself a compare-and-set.
- **A deletion's photos and audit entry in one transaction.** `remove` marks
  the Property deleted, then asks for each photo's deletion, then writes its
  audit entry, each its own statement. A failure between them leaves photos
  not asked to be deleted, or no audit entry, under a deleted Property, and a
  retry is answered `NOT_FOUND` (`docs/decisions/TODO.md`, *Make a Property's
  deletion, its photos' deletion requests and its audit entry one commit*).

## Consequences

- `@app/domain`: `PropertyRepository` loses `update` and gains
  `updateDetails` and `markDeleted`; new type `PropertyDetailsChange`.
  `PropertyService.update` and `remove` answer a lost race `NOT_FOUND`.
- `@app/database`: `createPrismaPropertyRepositories` implements the two
  methods.
- No migration, no route, no page.
