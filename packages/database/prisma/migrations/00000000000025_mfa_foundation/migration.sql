-- MFA-1: authenticator-app MFA and recovery codes, foundation (ADR-0065,
-- implementing ADR-0052 Decision 18).
--
-- `user_mfa_factors`: a user's TOTP factor. The row exists exactly while MFA is
-- on. The secret is stored sealed (AES-256-GCM under MFA_SECRET_KEY), never in
-- clear.
-- `user_mfa_recovery_codes`: unused recovery codes, as SHA-256 hashes only.
-- Using a code deletes it; deleting the factor deletes them all.
-- `sessions` gains its MFA state: when the sign-in passed MFA, how many wrong
-- codes it has entered, and the sealed secret of a set-up it started.
--
-- Additive only. Existing sessions read as not having passed MFA, which changes
-- nothing until a later milestone checks it. No existing row is updated or
-- deleted, and migrations 0 through 24 are not touched.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "mfaFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfaPendingSecret" TEXT,
ADD COLUMN     "mfaVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "user_mfa_factors" (
    "userId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "lastUsedStep" INTEGER NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_mfa_factors_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "user_mfa_recovery_codes" (
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_mfa_recovery_codes_pkey" PRIMARY KEY ("userId","codeHash")
);

-- AddForeignKey
ALTER TABLE "user_mfa_factors" ADD CONSTRAINT "user_mfa_factors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_mfa_recovery_codes" ADD CONSTRAINT "user_mfa_recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_mfa_factors"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only a hash can be stored, never a code as typed.
ALTER TABLE "user_mfa_recovery_codes"
  ADD CONSTRAINT "user_mfa_recovery_codes_codeHash_check"
  CHECK ("codeHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_mfaFailedAttempts_check"
  CHECK ("mfaFailedAttempts" >= 0);
