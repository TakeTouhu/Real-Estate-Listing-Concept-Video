-- UP-2 — the Unit purchase record (ADR-0067).
--
-- One table: each customer-approved purchase of an additional Unit package,
-- naming the period its Units belong to, the quality-locked block it bought,
-- the price it was approved at (excluding tax), how it is paid, the contract it
-- is invoiced under, and who approved it. The purchase, its block and their
-- audit entries are written in one transaction; nothing here grants a Unit on
-- its own.
--
-- The block's Units are not repeated here: the composite key ties the purchase
-- to a block of its own period and its own quality, and the block holds the
-- quantity. `approvedByUserId` is not a foreign key, as no actor column is:
-- billing evidence outlives the user.
--
-- Additive only. No existing table, column or row is read, updated or deleted,
-- and migrations 0 through 26 are not touched.

-- CreateTable
CREATE TABLE "unit_purchases" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entitlementPeriodId" TEXT NOT NULL,
    "addOnBlockId" TEXT NOT NULL,
    "quality" "GenerationQualityTier" NOT NULL,
    "priceYenExTax" INTEGER NOT NULL,
    "channel" "SubscriptionChannel" NOT NULL,
    "contractReference" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unit_purchases_addOnBlockId_key" ON "unit_purchases"("addOnBlockId");

-- CreateIndex
CREATE INDEX "unit_purchases_organizationId_approvedAt_idx" ON "unit_purchases"("organizationId", "approvedAt");

-- CreateIndex
CREATE INDEX "unit_purchases_entitlementPeriodId_idx" ON "unit_purchases"("entitlementPeriodId");

-- CreateIndex
CREATE UNIQUE INDEX "unit_purchases_organizationId_idempotencyKey_key" ON "unit_purchases"("organizationId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "unit_purchases" ADD CONSTRAINT "unit_purchases_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_purchases" ADD CONSTRAINT "unit_purchases_entitlementPeriodId_organizationId_fkey" FOREIGN KEY ("entitlementPeriodId", "organizationId") REFERENCES "unit_entitlement_periods"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_purchases" ADD CONSTRAINT "unit_purchases_addOnBlockId_entitlementPeriodId_quality_fkey" FOREIGN KEY ("addOnBlockId", "entitlementPeriodId", "quality") REFERENCES "unit_add_on_blocks"("id", "entitlementPeriodId", "quality") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Shape: a purchase is paid for, names its contract, and carries a usable
-- idempotency key.
ALTER TABLE "unit_purchases"
  ADD CONSTRAINT "unit_purchases_shape_check"
  CHECK (
    "priceYenExTax" > 0
    AND length("contractReference") > 0
    AND length("idempotencyKey") BETWEEN 1 AND 200
  );
