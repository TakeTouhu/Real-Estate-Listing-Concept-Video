-- UP-5 — cancelling a mistaken Unit purchase (ADR-0070).
--
-- One table: an operator's cancellation of a purchase, at most one per
-- purchase, naming whose mistake it was, who cancelled it and why. The
-- cancellation and its audit entry are written in one transaction under the
-- period's cost-admission lock. From then on no new reservation may draw on
-- the purchase's block, and the purchase is not invoiced; Units already used
-- stay used. The customer's own mistake is cancelled only within 10 hours of
-- its approval with no Unit used, which the repository decides under that
-- lock: no row records a refusal.
--
-- The purchase row is not changed: billing evidence is never rewritten
-- (ADR-0067 Decision 2). How many of its Units were used, still running and
-- withdrawn is recorded in the audit entry, not here: the ledger derives what
-- remains from allocations alone and stores no count.
--
-- The composite key keeps a cancellation inside its purchase's organization,
-- which needs a unique index on "unit_purchases"("id", "organizationId"). "id"
-- is already its primary key, so the index admits every existing row.
--
-- Additive only. No existing table, column or row is read, updated or deleted,
-- and migrations 0 through 27 are not touched.

-- CreateEnum
CREATE TYPE "UnitPurchaseCancellationFault" AS ENUM ('VTAVISION', 'CUSTOMER');

-- CreateTable
CREATE TABLE "unit_purchase_cancellations" (
    "purchaseId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fault" "UnitPurchaseCancellationFault" NOT NULL,
    "operatorName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_purchase_cancellations_pkey" PRIMARY KEY ("purchaseId")
);

-- CreateIndex
CREATE UNIQUE INDEX "unit_purchases_id_organizationId_key" ON "unit_purchases"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "unit_purchase_cancellations" ADD CONSTRAINT "unit_purchase_cancellations_purchaseId_organizationId_fkey" FOREIGN KEY ("purchaseId", "organizationId") REFERENCES "unit_purchases"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Shape: a cancellation names its operator and its reason, within the lengths
-- the command accepts.
ALTER TABLE "unit_purchase_cancellations"
  ADD CONSTRAINT "unit_purchase_cancellations_shape_check"
  CHECK (
    length("operatorName") BETWEEN 1 AND 200
    AND length("reason") BETWEEN 1 AND 500
  );
