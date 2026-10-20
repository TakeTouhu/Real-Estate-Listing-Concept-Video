-- DS-4 — the Clean Master record (ADR-0074, ADR-0052 Decision 17).
--
-- One table: the receipt for the overlay-free master of one deliverable
-- version, stored at the internal location no signed URL reaches. A row is
-- written once, with every column, after the bytes are proven stored, and never
-- updated. Nothing writes one yet; composition does from DS-5.
--
-- No backfill and no existing row touched: no composition has made a master, so
-- no version has one.

-- CreateTable
CREATE TABLE "generation_deliverable_clean_masters" (
    "id" TEXT NOT NULL,
    "deliverableVersionId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_deliverable_clean_masters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One master per version whose composition encoded it.
CREATE UNIQUE INDEX "generation_deliverable_clean_masters_deliverableVersionId_key" ON "generation_deliverable_clean_masters"("deliverableVersionId");

-- AddForeignKey
-- RESTRICT, never Cascade: no version is deleted from under its master.
ALTER TABLE "generation_deliverable_clean_masters" ADD CONSTRAINT "generation_deliverable_clean_masters_deliverableVersionId_fkey" FOREIGN KEY ("deliverableVersionId") REFERENCES "generation_deliverable_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shape: the key is the version's own key in the internal namespace.
--
-- The whole key is rebuilt from its organization segment and the row's version
-- id, so it has exactly five segments, the third is `internal` and the fifth is
-- this row's version. Every stored master is therefore at a key the signers
-- refuse (ADR-0074), and no row can point at a customer's object or at another
-- version's master. The organization itself cannot be checked here: the row
-- reaches it through the version's job, and the writer derives the key from it.
ALTER TABLE "generation_deliverable_clean_masters"
  ADD CONSTRAINT "deliverable_clean_master_key_check"
  CHECK (
    split_part("storageKey", '/', 2) <> ''
    AND "storageKey" = 'org/' || split_part("storageKey", '/', 2) || '/internal/clean-masters/' || "deliverableVersionId"
  );

-- Shape: canonical lowercase hex, and a byte count the domain can represent.
--
-- As for the composition's receipt: zero bytes was never a stored master, and
-- the upper bound keeps the column's range and the domain's range the same.
ALTER TABLE "generation_deliverable_clean_masters"
  ADD CONSTRAINT "deliverable_clean_master_receipt_check"
  CHECK (
    "sha256" ~ '^[0-9a-f]{64}$'
    AND "sizeBytes" > 0
    AND "sizeBytes" <= 9007199254740991
  );
