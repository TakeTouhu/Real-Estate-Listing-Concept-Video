-- AT-3a — email verification links (ADR-0128, implementing ADR-0052
-- Decision 18).
--
--   users.emailVerifiedAt  when the person opened a verification link sent to
--                          the account's address; NULL until then
--   account_links          one-time links mailed to a user: an email
--                          verification now, a password reset from AT-4
--
-- A link keeps only the SHA-256 of its token, the address it was sent to, when
-- it expires and when it was used. Deleting a user deletes its links.
--
-- Every existing user reads as unverified. Nothing checks the column until a
-- later milestone. No existing row is updated or deleted, and migrations 0
-- through 32 are not touched.
--
-- The CHECKs below cannot be expressed in Prisma, so the schema drift check
-- does not see them.

-- CreateEnum
CREATE TYPE "AccountLinkPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "account_links" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "AccountLinkPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_links_tokenHash_key" ON "account_links"("tokenHash");

-- CreateIndex
CREATE INDEX "account_links_userId_purpose_idx" ON "account_links"("userId", "purpose");

-- AddForeignKey
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only a hash can be stored, never a token as mailed.
ALTER TABLE "account_links"
  ADD CONSTRAINT "account_links_tokenHash_check"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

-- A link expires after it is made, and is used, if at all, after it is made.
ALTER TABLE "account_links"
  ADD CONSTRAINT "account_links_window_check"
  CHECK ("expiresAt" > "createdAt" AND ("usedAt" IS NULL OR "usedAt" >= "createdAt"));
