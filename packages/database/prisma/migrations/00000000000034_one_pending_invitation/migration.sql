-- AT-6a — one pending invitation per address in an organization (ADR-0135).
--
--   invitations_one_pending_per_email  unique ("organizationId", "email")
--                                      among the rows whose status is PENDING
--
-- Inviting an address already reads for a pending invitation first and is
-- refused, but only by that read; two invitations sent at the same moment
-- could both pass it. From AT-6a the inviting transaction locks the
-- organization's row, and this index refuses a second pending row whatever
-- path writes it.
--
-- An invitation past its expiry stays PENDING until something marks it
-- EXPIRED. The inviting transaction does that for the address it invites
-- before it writes, so an expired invitation never blocks a new one.
--
-- No route has created an invitation yet (role-templates-shape.test.ts), so no
-- environment holds two pending invitations of one address. If one did, this
-- migration would fail rather than choose between them. No existing row is
-- updated or deleted, and migrations 0 through 33 are not touched.
--
-- Prisma cannot express the WHERE, so the schema drift check does not see
-- this index (docs/migration-notes.md).

-- CreateIndex
CREATE UNIQUE INDEX "invitations_one_pending_per_email"
  ON "invitations" ("organizationId", "email")
  WHERE "status" = 'PENDING';
