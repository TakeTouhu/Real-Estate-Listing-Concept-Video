-- Seed at migration 00000000000035_rate_limit_counters (ADR-0191 Decision 4, PT-8b1). Data only: upgrade.sh applies
-- the migrations up to this level, runs this file in one transaction, then applies the head's remaining set.
--
-- Adversarial but valid here: every enum value of a seeded column, NULL and a value in every nullable column, rows
-- sharing what a later uniqueness rule could refuse (addresses differing only in case, one address PENDING and EXPIRED,
-- the same reference, key or name in two organizations), and the lengths the CHECKs bound. Every value is fake:
-- example.com addresses, hex built from 5eed35, no real hash or secret. Every key holds seed35, or 5eed35 for hex, so
-- check.sql finds these rows. The media, storyboard and generation tables come in PT-8b2.

INSERT INTO organizations (id, name, slug, status, "mfaRequired", "createdAt", "updatedAt") VALUES
  ('org_seed35_a', 'Seed Org A', 'seed35-a', 'ACTIVE', false, '2026-01-01', '2026-01-01'),
  ('org_seed35_b', 'Seed Org B', 'seed35-b', 'SUSPENDED', true, '2026-01-01', '2026-01-02'),
  ('org_seed35_c', 'Seed Org A', 'SEED35-A', 'ACTIVE', false, '2026-01-01', '2026-01-01');

-- The viewer's address differs from the owner's only in case.
INSERT INTO users (id, email, name, status, "emailVerifiedAt", "createdAt", "updatedAt") VALUES
  ('usr_seed35_owner', 'owner@example.com', 'Seed Owner', 'ACTIVE', '2026-01-01', '2026-01-01', '2026-01-01'),
  ('usr_seed35_admin', 'admin@example.com', 'Seed Admin', 'ACTIVE', NULL, '2026-01-01', '2026-01-01'),
  ('usr_seed35_manager', 'manager@example.com', 'Seed Manager', 'ACTIVE', NULL, '2026-01-01', '2026-01-01'),
  ('usr_seed35_creator', 'creator@example.com', 'Seed Creator', 'ACTIVE', NULL, '2026-01-01', '2026-01-01'),
  ('usr_seed35_viewer', 'OWNER@example.com', 'Seed Viewer', 'ACTIVE', NULL, '2026-01-01', '2026-01-01'),
  ('usr_seed35_billing', 'billing@example.com', 'Seed Billing', 'DISABLED', NULL, '2026-01-01', '2026-01-01');

INSERT INTO credentials ("userId", "passwordHash", "createdAt", "updatedAt") VALUES
  ('usr_seed35_owner', 'fake-hash:' || lpad('', 64, '5eed35'), '2026-01-01', '2026-01-01'),
  ('usr_seed35_admin', 'fake-hash:' || lpad('', 64, '5eed35'), '2026-01-01', '2026-01-01');

INSERT INTO user_mfa_factors ("userId", secret, "lastUsedStep", "enabledAt", "updatedAt") VALUES
  ('usr_seed35_owner', 'fake-key:' || lpad('', 64, '5eed35'), 0, '2026-01-01', '2026-01-01'),
  ('usr_seed35_admin', 'fake-key:' || lpad('', 64, '5eed35'), 2147483647, '2026-01-01', '2026-01-01');

-- The same hash for two users: the key is (userId, codeHash).
INSERT INTO user_mfa_recovery_codes ("userId", "codeHash", "createdAt") VALUES
  ('usr_seed35_owner', lpad('01', 64, '5eed35'), '2026-01-01'),
  ('usr_seed35_owner', lpad('02', 64, '5eed35'), '2026-01-01'),
  ('usr_seed35_admin', lpad('01', 64, '5eed35'), '2026-01-01');

-- Two verification links for one user, one used at the instant it was made.
INSERT INTO account_links (id, "userId", purpose, "tokenHash", email, "expiresAt", "usedAt", "createdAt") VALUES
  ('lnk_seed35_1', 'usr_seed35_owner', 'EMAIL_VERIFICATION', lpad('11', 64, '5eed35'), 'owner@example.com',
   '2026-01-02', '2026-01-01', '2026-01-01'),
  ('lnk_seed35_2', 'usr_seed35_owner', 'EMAIL_VERIFICATION', lpad('12', 64, '5eed35'), 'Owner@example.com',
   '2026-01-02', NULL, '2026-01-01'),
  ('lnk_seed35_3', 'usr_seed35_admin', 'PASSWORD_RESET', lpad('13', 64, '5eed35'), 'admin@example.com',
   '2026-01-01 00:00:00.001', NULL, '2026-01-01');

INSERT INTO sessions (id, "userId", "tokenHash", "expiresAt", "mfaVerifiedAt", "mfaFailedAttempts",
  "mfaPendingSecret", "createdAt") VALUES
  ('ses_seed35_1', 'usr_seed35_owner', lpad('21', 64, '5eed35'), '2026-01-02', '2026-01-01', 4,
   'fake-key:' || lpad('', 64, '5eed35'), '2026-01-01'),
  ('ses_seed35_2', 'usr_seed35_owner', lpad('22', 64, '5eed35'), '2026-01-02', NULL, 0, NULL, '2026-01-01');

-- Every role in one organization; one user in two organizations.
INSERT INTO memberships ("organizationId", "userId", role, "createdAt") VALUES
  ('org_seed35_a', 'usr_seed35_owner', 'OWNER', '2026-01-01'),
  ('org_seed35_a', 'usr_seed35_admin', 'ADMIN', '2026-01-01'),
  ('org_seed35_a', 'usr_seed35_manager', 'MANAGER', '2026-01-01'),
  ('org_seed35_a', 'usr_seed35_creator', 'CREATOR', '2026-01-01'),
  ('org_seed35_a', 'usr_seed35_viewer', 'VIEWER', '2026-01-01'),
  ('org_seed35_a', 'usr_seed35_billing', 'BILLING', '2026-01-01'),
  ('org_seed35_b', 'usr_seed35_owner', 'OWNER', '2026-01-01'),
  ('org_seed35_c', 'usr_seed35_viewer', 'OWNER', '2026-01-01');

INSERT INTO member_permission_grants ("organizationId", "userId", permission, "grantedByUserId", "grantedAt") VALUES
  ('org_seed35_a', 'usr_seed35_manager', 'disclosure.none', 'usr_seed35_owner', '2026-01-01'),
  ('org_seed35_a', 'usr_seed35_creator', 'disclosure.none', 'usr_seed35_owner', '2026-01-01'),
  ('org_seed35_a', 'usr_seed35_manager', 'billing.view', 'usr_seed35_owner', '2026-01-01');

-- Names differing only in case, one name in two organizations, and the 1- and 100-character bounds.
INSERT INTO groups (id, "organizationId", name, "createdByUserId", "createdAt", "updatedAt") VALUES
  ('grp_seed35_a1', 'org_seed35_a', 'Sales', 'usr_seed35_owner', '2026-01-01', '2026-01-01'),
  ('grp_seed35_a2', 'org_seed35_a', 'sales', 'usr_seed35_owner', '2026-01-01', '2026-01-01'),
  ('grp_seed35_a3', 'org_seed35_a', repeat('g', 100), 'usr_seed35_owner', '2026-01-01', '2026-01-01'),
  ('grp_seed35_b1', 'org_seed35_b', 'Sales', 'usr_seed35_owner', '2026-01-01', '2026-01-01'),
  ('grp_seed35_b2', 'org_seed35_b', 'x', 'usr_seed35_owner', '2026-01-01', '2026-01-01');

INSERT INTO group_members ("groupId", "organizationId", "userId", "addedByUserId", "addedAt") VALUES
  ('grp_seed35_a1', 'org_seed35_a', 'usr_seed35_manager', 'usr_seed35_owner', '2026-01-01'),
  ('grp_seed35_a2', 'org_seed35_a', 'usr_seed35_manager', 'usr_seed35_owner', '2026-01-01'),
  ('grp_seed35_a1', 'org_seed35_a', 'usr_seed35_creator', 'usr_seed35_owner', '2026-01-01'),
  ('grp_seed35_b1', 'org_seed35_b', 'usr_seed35_owner', 'usr_seed35_owner', '2026-01-01');

INSERT INTO group_permissions ("groupId", "organizationId", permission, "grantedByUserId", "grantedAt") VALUES
  ('grp_seed35_a1', 'org_seed35_a', 'video.generate', 'usr_seed35_owner', '2026-01-01'),
  ('grp_seed35_a2', 'org_seed35_a', 'video.generate', 'usr_seed35_owner', '2026-01-01'),
  ('grp_seed35_a1', 'org_seed35_a', 'asset.upload', 'usr_seed35_owner', '2026-01-01');

-- One address in every state, a second PENDING one differing only in case, and the address PENDING elsewhere.
INSERT INTO invitations (id, "organizationId", email, role, "tokenHash", status, "invitedByUserId", "expiresAt",
  "acceptedAt", "createdAt") VALUES
  ('inv_seed35_1', 'org_seed35_a', 'invitee@example.com', 'OWNER', lpad('31', 64, '5eed35'), 'PENDING',
   'usr_seed35_owner', '2026-01-08', NULL, '2026-01-01'),
  ('inv_seed35_2', 'org_seed35_a', 'invitee@example.com', 'ADMIN', lpad('32', 64, '5eed35'), 'EXPIRED',
   'usr_seed35_owner', '2026-01-08', NULL, '2026-01-01'),
  ('inv_seed35_3', 'org_seed35_a', 'invitee@example.com', 'MANAGER', lpad('33', 64, '5eed35'), 'ACCEPTED',
   'usr_seed35_owner', '2026-01-08', '2026-01-02', '2026-01-01'),
  ('inv_seed35_4', 'org_seed35_a', 'invitee@example.com', 'CREATOR', lpad('34', 64, '5eed35'), 'REVOKED',
   'usr_seed35_owner', '2026-01-08', NULL, '2026-01-01'),
  ('inv_seed35_5', 'org_seed35_a', 'Invitee@example.com', 'VIEWER', lpad('35', 64, '5eed35'), 'PENDING',
   'usr_seed35_owner', '2026-01-08', NULL, '2026-01-01'),
  ('inv_seed35_6', 'org_seed35_b', 'invitee@example.com', 'BILLING', lpad('36', 64, '5eed35'), 'PENDING',
   'usr_seed35_owner', '2026-01-08', NULL, '2026-01-01');

-- Two rows with the same action and resource, and one with no organization or actor.
INSERT INTO audit_logs (id, "organizationId", "actorUserId", action, "resourceType", "resourceId", metadata,
  "createdAt") VALUES
  ('aud_seed35_1', 'org_seed35_a', 'usr_seed35_owner', 'member.invite', 'invitation', 'inv_seed35_1',
   '{"seed": 35}', '2026-01-01'),
  ('aud_seed35_2', 'org_seed35_a', 'usr_seed35_owner', 'member.invite', 'invitation', 'inv_seed35_1',
   '{"seed": 35}', '2026-01-01'),
  ('aud_seed35_3', NULL, NULL, 'member.invite', 'invitation', 'inv_seed35_1', '{}', '2026-01-01');

-- Every plan and channel; one commercial reference in two organizations, and the 1-character bound.
INSERT INTO organization_subscriptions (id, "organizationId", "planKey", channel, "anchorAt", "commercialReference",
  "createdAt") VALUES
  ('sub_seed35_a', 'org_seed35_a', 'STANDARD', 'SELF_SERVICE', '2026-01-01', 'seed35-contract', '2026-01-01'),
  ('sub_seed35_b', 'org_seed35_b', 'PREMIUM', 'SALES_ASSISTED', '2026-01-01', 'seed35-contract', '2026-01-01'),
  ('sub_seed35_c', 'org_seed35_c', 'ENTERPRISE', 'SALES_ASSISTED', '2026-01-01', 'x', '2026-01-01');

-- Adjacent periods of one organization; one cycle key in three; HQ units equal to base units, and zero.
INSERT INTO unit_entitlement_periods (id, "organizationId", "billingCycleKey", "planKey", "baseUnits",
  "includedHighQualityUnits", "highQualityAddOnAvailable", "startsAt", "endsAt", "commercialReference", "createdAt")
  VALUES
  ('per_seed35_a1', 'org_seed35_a', 'seed35-2026-01', 'STANDARD', 0, 0, false, '2026-01-01', '2026-02-01', NULL,
   '2026-01-01'),
  ('per_seed35_a2', 'org_seed35_a', 'seed35-2026-02', 'STANDARD', 30, 30, true, '2026-02-01', '2026-03-01', 'x',
   '2026-01-01'),
  ('per_seed35_b1', 'org_seed35_b', 'seed35-2026-01', 'PREMIUM', 60, 10, true, '2026-01-01', '2026-02-01',
   'seed35-contract', '2026-01-01'),
  ('per_seed35_c1', 'org_seed35_c', 'seed35-2026-01', 'ENTERPRISE', 100, 0, false, '2026-01-01', '2026-02-01',
   'seed35-contract', '2026-01-01');

-- Both qualities in one period bought at the same instant; one order reference in two organizations.
INSERT INTO unit_add_on_blocks (id, "organizationId", "entitlementPeriodId", quality, quantity, "commercialReference",
  "purchasedAt", "createdAt") VALUES
  ('blk_seed35_a1', 'org_seed35_a', 'per_seed35_a2', 'NORMAL', 1, 'seed35-order-1', '2026-02-02', '2026-02-02'),
  ('blk_seed35_a2', 'org_seed35_a', 'per_seed35_a2', 'HIGH_QUALITY', 2147483647, 'x', '2026-02-02', '2026-02-02'),
  ('blk_seed35_b1', 'org_seed35_b', 'per_seed35_b1', 'NORMAL', 10, 'seed35-order-1', '2026-01-02', '2026-01-02');

-- One idempotency key in two organizations, and its 1- and 200-character bounds.
INSERT INTO unit_purchases (id, "organizationId", "entitlementPeriodId", "addOnBlockId", quality, "priceYenExTax",
  channel, "contractReference", "idempotencyKey", "approvedByUserId", "approvedAt", "createdAt") VALUES
  ('pur_seed35_a1', 'org_seed35_a', 'per_seed35_a2', 'blk_seed35_a1', 'NORMAL', 1, 'SELF_SERVICE', 'x', 'k',
   'usr_seed35_billing', '2026-02-02', '2026-02-02'),
  ('pur_seed35_a2', 'org_seed35_a', 'per_seed35_a2', 'blk_seed35_a2', 'HIGH_QUALITY', 2147483647, 'SALES_ASSISTED',
   'seed35-contract', repeat('k', 200), 'usr_seed35_owner', '2026-02-02', '2026-02-02'),
  ('pur_seed35_b1', 'org_seed35_b', 'per_seed35_b1', 'blk_seed35_b1', 'NORMAL', 5000, 'SALES_ASSISTED',
   'seed35-contract', 'k', 'usr_seed35_owner', '2026-01-02', '2026-01-02');

INSERT INTO unit_purchase_cancellations ("purchaseId", "organizationId", fault, "operatorName", reason, "cancelledAt")
  VALUES
  ('pur_seed35_a1', 'org_seed35_a', 'VTAVISION', 'o', 'r', '2026-02-02'),
  ('pur_seed35_b1', 'org_seed35_b', 'CUSTOMER', repeat('o', 200), repeat('r', 500), '2026-01-02');

-- One subject under two policies; the 3- and 64-character policy bounds; a window that expires as it starts.
INSERT INTO rate_limit_counters (policy, subject, "windowStartedAt", count, "lockedUntil", "lockLevel", "expiresAt")
  VALUES
  ('seed35.sign-in', lpad('41', 64, '5eed35'), '2026-01-01', 0, NULL, 0, '2026-01-01'),
  ('seed35.sign-up', lpad('41', 64, '5eed35'), '2026-01-01', 6, '2026-01-01 00:15', 2, '2026-01-02'),
  ('a.b', lpad('42', 64, '5eed35'), '2026-01-01', 1, NULL, 0, '2026-01-01 00:01'),
  ('seed35.' || repeat('p', 57), lpad('43', 64, '5eed35'), '2026-01-01', 2147483647, NULL, 0, '2026-01-02');
