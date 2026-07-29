# ADR-0011: Database constraints beyond the Prisma schema

- Status: Accepted
- Date: 2026-07-29
- Phase: 3B-1a

## Context

`packages/database/prisma/schema.prisma` is the source of truth for the data
model, and every migration so far has been generated from it. That has held
because Prisma could express every constraint the domain needed: primary keys,
foreign keys with cascade behaviour, plain and composite unique indexes, and
ordinary indexes.

Phase 3B-1a needed a constraint Prisma cannot express. The rule is "at most one
`APPROVED` analysis per duplicate group", which in PostgreSQL is a partial
unique index:

```sql
CREATE UNIQUE INDEX "asset_analyses_org_dupgroup_approved_key"
  ON "asset_analyses" ("organizationId", "duplicateGroup")
  WHERE "duplicateGroup" IS NOT NULL AND "reviewStatus" = 'APPROVED';
```

Prisma 5.22 has no syntax for the `WHERE` clause; `@@unique([...], where: {...})`
fails `prisma validate` outright.

The alternative was to enforce the rule only in application code — read the
group's members, check none is approved, then write. That is a
check-then-act race: two concurrent approvals of different members can both
read "none approved" and both write. Application code cannot close that window
without a database-level guarantee, and the review gate is exactly the place
where two approved primaries must be impossible rather than unlikely.

## Decision

**Raw SQL in a migration is permitted when Prisma cannot express a database
invariant the domain requires.** The Prisma schema remains the source of truth
for everything it *can* express; raw SQL is the documented exception, not a
parallel track.

Conditions on using it:

1. **Only for invariants, not convenience.** Correctness constraints the
   database must own — partial or expression indexes, check constraints,
   exclusion constraints. Not for anything the schema can already state.
2. **Appended to a generated migration**, never hand-written wholesale. The
   generated portion still comes from `prisma migrate diff`.
3. **Commented in the migration** with what it enforces and why Prisma cannot
   express it.
4. **Recorded in `docs/migration-notes.md`**, including the rollback statement.
5. **Covered by a live-PostgreSQL integration test** asserting the constraint
   actually refuses the case it exists to prevent. An invariant the datamodel
   cannot see is one that no type or generated client will protect, so the test
   is the only mechanism that keeps it honest.
6. **The CI drift check must still pass**, verified rather than assumed.

For the Phase 3B-1a index, condition 6 was tested before the approach was
committed to: `prisma migrate diff --from-migrations --to-schema-datamodel
--exit-code` reports `No difference detected.` because Prisma ignores an index
it cannot represent.

## Consequences

**Accepted:**

- Invariants that genuinely belong in the database can live there, so
  concurrency is settled by the database rather than by hopeful application
  ordering. The losing writer gets a unique violation instead of a second
  approved primary.
- The escape hatch is narrow and documented, so "we couldn't express it in
  Prisma" does not become a habit of hand-writing schema changes.

**Costs and risks:**

- **`prisma migrate dev` may generate a migration that drops the constraint**,
  because it is invisible to the datamodel and therefore looks like drift to be
  cleaned up. Every future generated migration must be inspected for a
  `DROP INDEX` / `DROP CONSTRAINT` naming one of these objects. This is the
  sharpest edge of the decision and the most likely way it fails in practice.
- The constraint is invisible to the generated Prisma client, so nothing in
  TypeScript signals it. Violations surface as runtime errors that services must
  map deliberately — in 3B-1b, a unique violation on this index maps to
  `VALIDATION_FAILED` and is never retried or reconciled, unlike the
  insert-race reconciliation in Phase 3A-2b.
- `prisma db pull` would not reproduce these objects into the schema, so the
  schema file alone no longer fully describes the database. `docs/migration-notes.md`
  is the register of what else exists.
- Each such constraint needs its own integration test, since no generated
  artifact enforces it.

**If the number of these grows**, the register in `docs/migration-notes.md`
becomes the thing to watch: more than a handful would argue for either moving to
a migration tool that models them natively, or accepting the schema file as a
partial description and treating the migrations directory as authoritative.

## References

- ADR-0007 — persistence and tenant isolation
- `docs/migration-notes.md` — migration 4 and the `migrate dev` caveat
- `docs/phase-3b1a-completion.md` — the empirical drift-check verification
- `tests/integration/review-transaction.db.test.ts` — the five cases proving the
  index behaves as intended
