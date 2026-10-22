-- DS-5b-2a — two reasons composition can stop at the Clean Master (ADR-0077,
-- planned by ADR-0076 Decision 5).
--
-- Two values for the block-code enum of migration 15, and nothing else:
--
--   CLEAN_MASTER_SIZE_LIMIT_EXCEEDED  the stored master is over its 1 GiB
--                                     ceiling (ADR-0076 Decision 1)
--   CLEAN_MASTER_UNUSABLE             the stored master is not a video the
--                                     disclosure can be laid over, or not the
--                                     profile's size and frame rate (ADR-0076
--                                     Decision 3)
--
-- Each is deterministic for the same reason the four existing codes are: the
-- master is stored first-wins and never replaced, so a later attempt reads the
-- same bytes and reaches the same answer.
--
-- `ADD VALUE`, as Prisma itself writes an added enum value, rather than
-- migration 19's recreated type: that was needed only because a value was
-- removed. Nothing in this migration uses either value, so PostgreSQL's rule
-- that a value added in a transaction cannot be used before it commits does not
-- apply. No existing row is touched: no composition has been blocked for its
-- master, because none makes one yet.

-- AlterEnum
ALTER TYPE "DeliverableCompositionBlockCode" ADD VALUE 'CLEAN_MASTER_SIZE_LIMIT_EXCEEDED';
ALTER TYPE "DeliverableCompositionBlockCode" ADD VALUE 'CLEAN_MASTER_UNUSABLE';
