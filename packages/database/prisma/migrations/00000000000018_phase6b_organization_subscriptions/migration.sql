-- Phase 6B — the organization subscription (ADR-0056).
--
-- One table: which plan an organization is on, through which channel it was
-- sold, and the instant its monthly renewal periods are counted from. Renewal
-- periods are opened from it on demand through the Phase 6A ledger; none is
-- stored here, and nothing here counts Units.
--
-- Additive only. No existing table, column or row is read, updated or deleted,
-- and migrations 0 through 17 are not touched.

-- CreateEnum
CREATE TYPE "SubscriptionChannel" AS ENUM ('SELF_SERVICE', 'SALES_ASSISTED');

-- CreateTable
CREATE TABLE "organization_subscriptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planKey" "EntitlementPlanKey" NOT NULL,
    "channel" "SubscriptionChannel" NOT NULL,
    "anchorAt" TIMESTAMP(3) NOT NULL,
    "commercialReference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_subscriptions_organizationId_key" ON "organization_subscriptions"("organizationId");

-- AddForeignKey
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shape: every subscription names the commercial record it came from, and
-- Enterprise is never self-service (ADR-0053 Decisions 1A and 3B).
ALTER TABLE "organization_subscriptions"
  ADD CONSTRAINT "organization_subscriptions_shape_check"
  CHECK (
    length("commercialReference") > 0
    AND ("planKey" <> 'ENTERPRISE' OR "channel" = 'SALES_ASSISTED')
  );
