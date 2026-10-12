-- Phase 6A — the Unit entitlement ledger.
--
-- Three tables and one column pair (ADR-0053 Decisions 1–3, ADR-0055):
--
--   unit_entitlement_periods            one organization's entitlement for one
--                                       renewal period, plan snapshot frozen on it
--   unit_add_on_blocks                  one purchased, quality-locked package
--   generation_reservation_allocations  the frozen funding of a reservation:
--                                       Base or one named block, per row
--
-- **No balance column.** What remains of a period is derived from the
-- allocations of reservations that still occupy entitlement, so the reservation's
-- own compare-and-set settles every allocation of it in one commit.
--
-- **No guessed history.** Every existing reservation predates the ledger and
-- recorded no funding source. It is marked `UNALLOCATED_LEGACY` — the name of
-- that shape, not a claim about where its Units came from — and is given no
-- period and no allocation. The column default exists only for that one
-- statement and is dropped immediately, so every later writer must name the
-- funding model explicitly. Nothing here reads, updates or deletes an existing
-- row, and migrations 0 through 16 are not touched.

-- CreateEnum
CREATE TYPE "GenerationReservationFunding" AS ENUM ('UNALLOCATED_LEGACY', 'ALLOCATED');

-- CreateEnum
CREATE TYPE "EntitlementPlanKey" AS ENUM ('STANDARD', 'PREMIUM', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "UnitEntitlementSourceType" AS ENUM ('BASE', 'ADD_ON_BLOCK');

-- AlterTable
-- Existing rows take the legacy marker in this statement only; the default is
-- dropped below so no new reservation can acquire it by omission.
ALTER TABLE "generation_reservations" ADD COLUMN     "entitlementPeriodId" TEXT,
ADD COLUMN     "funding" "GenerationReservationFunding" NOT NULL DEFAULT 'UNALLOCATED_LEGACY';

ALTER TABLE "generation_reservations" ALTER COLUMN "funding" DROP DEFAULT;

-- CreateTable
CREATE TABLE "unit_entitlement_periods" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "billingCycleKey" TEXT NOT NULL,
    "planKey" "EntitlementPlanKey" NOT NULL,
    "baseUnits" INTEGER NOT NULL,
    "includedHighQualityUnits" INTEGER NOT NULL,
    "highQualityAddOnAvailable" BOOLEAN NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "commercialReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_entitlement_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_add_on_blocks" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entitlementPeriodId" TEXT NOT NULL,
    "quality" "GenerationQualityTier" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "commercialReference" TEXT NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_add_on_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_reservation_allocations" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entitlementPeriodId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "sourceType" "UnitEntitlementSourceType" NOT NULL,
    "addOnBlockId" TEXT,
    "quality" "GenerationQualityTier" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_reservation_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "unit_entitlement_periods_organizationId_startsAt_idx" ON "unit_entitlement_periods"("organizationId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "unit_entitlement_periods_organizationId_billingCycleKey_key" ON "unit_entitlement_periods"("organizationId", "billingCycleKey");

-- CreateIndex
CREATE UNIQUE INDEX "unit_entitlement_periods_id_organizationId_key" ON "unit_entitlement_periods"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "unit_entitlement_periods_id_billingCycleKey_key" ON "unit_entitlement_periods"("id", "billingCycleKey");

-- CreateIndex
CREATE INDEX "unit_add_on_blocks_entitlementPeriodId_quality_purchasedAt_idx" ON "unit_add_on_blocks"("entitlementPeriodId", "quality", "purchasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "unit_add_on_blocks_organizationId_commercialReference_key" ON "unit_add_on_blocks"("organizationId", "commercialReference");

-- CreateIndex
CREATE UNIQUE INDEX "unit_add_on_blocks_id_entitlementPeriodId_quality_key" ON "unit_add_on_blocks"("id", "entitlementPeriodId", "quality");

-- CreateIndex
CREATE INDEX "generation_reservation_allocations_entitlementPeriodId_idx" ON "generation_reservation_allocations"("entitlementPeriodId");

-- CreateIndex
CREATE INDEX "generation_reservation_allocations_addOnBlockId_idx" ON "generation_reservation_allocations"("addOnBlockId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_reservation_allocations_reservationId_ordinal_key" ON "generation_reservation_allocations"("reservationId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "generation_reservation_allocations_reservationId_addOnBlock_key" ON "generation_reservation_allocations"("reservationId", "addOnBlockId");

-- CreateIndex
CREATE INDEX "generation_reservations_entitlementPeriodId_idx" ON "generation_reservations"("entitlementPeriodId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_reservations_id_entitlementPeriodId_key" ON "generation_reservations"("id", "entitlementPeriodId");

-- AddForeignKey
ALTER TABLE "generation_reservations" ADD CONSTRAINT "generation_reservations_entitlementPeriodId_billingCycleKe_fkey" FOREIGN KEY ("entitlementPeriodId", "billingCycleKey") REFERENCES "unit_entitlement_periods"("id", "billingCycleKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_add_on_blocks" ADD CONSTRAINT "unit_add_on_blocks_entitlementPeriodId_organizationId_fkey" FOREIGN KEY ("entitlementPeriodId", "organizationId") REFERENCES "unit_entitlement_periods"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_reservation_allocations" ADD CONSTRAINT "generation_reservation_allocations_reservationId_entitleme_fkey" FOREIGN KEY ("reservationId", "entitlementPeriodId") REFERENCES "generation_reservations"("id", "entitlementPeriodId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_reservation_allocations" ADD CONSTRAINT "generation_reservation_allocations_entitlementPeriodId_org_fkey" FOREIGN KEY ("entitlementPeriodId", "organizationId") REFERENCES "unit_entitlement_periods"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_reservation_allocations" ADD CONSTRAINT "generation_reservation_allocations_addOnBlockId_entitlemen_fkey" FOREIGN KEY ("addOnBlockId", "entitlementPeriodId", "quality") REFERENCES "unit_add_on_blocks"("id", "entitlementPeriodId", "quality") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shape: a reservation names a funding period exactly when it is ALLOCATED.
ALTER TABLE "generation_reservations"
  ADD CONSTRAINT "generation_reservations_funding_period_check"
  CHECK (("funding" = 'ALLOCATED') = ("entitlementPeriodId" IS NOT NULL));

-- Shape: a period's plan snapshot is a real allowance, its HQ ceiling sits
-- inside its Base Units, and its bounds are a non-empty interval.
ALTER TABLE "unit_entitlement_periods"
  ADD CONSTRAINT "unit_entitlement_periods_shape_check"
  CHECK (
    "baseUnits" >= 0
    AND "includedHighQualityUnits" >= 0
    AND "includedHighQualityUnits" <= "baseUnits"
    AND "endsAt" > "startsAt"
    AND length("billingCycleKey") > 0
    AND ("commercialReference" IS NULL OR length("commercialReference") > 0)
  );

-- Shape: a block holds Units and names the purchase that bought them.
ALTER TABLE "unit_add_on_blocks"
  ADD CONSTRAINT "unit_add_on_blocks_shape_check"
  CHECK ("quantity" > 0 AND length("commercialReference") > 0);

-- Shape: an allocation draws a positive quantity, in a 1-based order, and names
-- a block exactly when it is an add-on allocation.
ALTER TABLE "generation_reservation_allocations"
  ADD CONSTRAINT "generation_reservation_allocations_shape_check"
  CHECK (
    "quantity" > 0
    AND "ordinal" >= 1
    AND (("sourceType" = 'BASE') = ("addOnBlockId" IS NULL))
  );

-- At most one Base allocation per reservation. The (reservationId, addOnBlockId)
-- unique index cannot say this, because NULLs are distinct; a Base draw is one
-- quantity-bearing row, never several. Prisma cannot express a partial index, so
-- it lives here (see docs/migration-notes.md).
CREATE UNIQUE INDEX "generation_reservation_allocations_one_base_key"
  ON "generation_reservation_allocations" ("reservationId")
  WHERE "sourceType" = 'BASE';
