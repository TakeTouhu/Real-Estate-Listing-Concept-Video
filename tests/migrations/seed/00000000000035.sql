-- Seed at migration 00000000000035_rate_limit_counters (ADR-0191 Decision 4, PT-8b1). Data only: upgrade.sh applies
-- the migrations up to this level, runs this file in one transaction, then applies the head's remaining set.
--
-- Adversarial but valid here: every enum value of a seeded column and every permission the CHECKs allow, NULL and a
-- value in every nullable column, rows sharing what a later uniqueness rule could refuse (addresses differing only in
-- case, one address PENDING and EXPIRED, the same reference, key or name in two organizations), and the lengths the
-- CHECKs bound. Every value is fake: example.com addresses, hex built from 5eed35, no real hash or secret. Every key
-- holds seed35, or 5eed35 for hex, so check.sql finds these rows. The property, media, storyboard, generation and FX
-- tables, Unit reservations and allocations included, come in PT-8b2.

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

-- Every permission migration 20's CHECK allows, granted to one member.
INSERT INTO member_permission_grants ("organizationId", "userId", permission, "grantedByUserId", "grantedAt")
  SELECT 'org_seed35_a', 'usr_seed35_admin', p, 'usr_seed35_owner', '2026-01-01' FROM unnest(ARRAY[
    'organization.view', 'organization.manage', 'member.view', 'member.manage', 'group.view', 'group.manage',
    'permission.manage', 'property.view', 'property.create', 'property.edit', 'property.delete', 'asset.upload',
    'asset.delete', 'analysis.review', 'video.view', 'video.generate', 'video.regenerate', 'video.download',
    'disclosure.change', 'disclosure.none', 'unit.consume', 'unit.view', 'billing.view', 'billing.manage',
    'audit.view', 'audit.export']) AS p;

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

-- Every permission migration 22's CHECK allows, granted to one group.
INSERT INTO group_permissions ("groupId", "organizationId", permission, "grantedByUserId", "grantedAt")
  SELECT 'grp_seed35_a3', 'org_seed35_a', p, 'usr_seed35_owner', '2026-01-01' FROM unnest(ARRAY[
    'organization.view', 'organization.manage', 'member.view', 'member.manage', 'group.view', 'group.manage',
    'permission.manage', 'property.view', 'property.create', 'property.edit', 'property.delete', 'asset.upload',
    'asset.delete', 'analysis.review', 'video.view', 'video.generate', 'video.regenerate', 'video.download',
    'disclosure.change', 'unit.consume', 'unit.view', 'billing.view', 'billing.manage', 'audit.view',
    'audit.export']) AS p;

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

-- Adjacent periods of one organization; one cycle key in three, and the 1-character key; HQ units equal to base
-- units, and zero.
INSERT INTO unit_entitlement_periods (id, "organizationId", "billingCycleKey", "planKey", "baseUnits",
  "includedHighQualityUnits", "highQualityAddOnAvailable", "startsAt", "endsAt", "commercialReference", "createdAt")
  VALUES
  ('per_seed35_a1', 'org_seed35_a', 'seed35-2026-01', 'STANDARD', 0, 0, false, '2026-01-01', '2026-02-01', NULL,
   '2026-01-01'),
  ('per_seed35_a2', 'org_seed35_a', 'x', 'STANDARD', 30, 30, true, '2026-02-01', '2026-03-01', 'x',
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

-- PT-8b2: the property, media, storyboard, generation and FX tables. Every enum value, and NULL and a value in every
-- nullable column, is seeded in a combination the rules below allow; not every cross-combination they allow is. These
-- rules tie columns together, so what they forbid is not seeded:
-- * An enum with one value here (DisclosureMode, ManagedOutputContainerFamily) is covered by that value.
-- * Media and deliverable validations: an invalid reason only on INVALID_MEDIA, the probe facts and container only
--   on VALID, a lease only on RUNNING, nextAttemptAt only on PENDING; a deliverable validation's PENDING needs
--   nextAttemptAt, a media one's may lack it. Compositions: a retry code only on PENDING, a block code only on
--   BLOCKED, the output only on OUTPUT_VERIFIED; crf is 18. Failure resolutions: a kind only on RESOLVED, a recovery
--   attempt only with RECOVERY_ADMITTED.
-- * Jobs: units follow the duration, high-quality units equal them on HIGH_QUALITY and are 0 on NORMAL. Requests: an
--   ordinal (1 or 2) only on USER_REGENERATION; a second INITIAL, active regeneration or delivered ordinal for one
--   scene is refused. Reservations: ALLOCATED exactly when a period is named. Allocations: a block exactly when the
--   source is ADD_ON_BLOCK, of the block's quality; one BASE per reservation.
-- * Scene generations: the six orchestration columns are all set or all NULL; a sha256:v2: hash needs the five v2
--   fields and no requestResolution, another hash none of them; an orchestrated prediction only when ACCEPTED, which
--   needs one; an orchestrated row past QUEUED and CANCELLED_PRE_SUBMISSION needs submissionBoundaryEnteredAt;
--   RECONCILIATION_PENDING needs its times, OUTPUT_VERIFIED its receipt; one active attempt and one PRIMARY per
--   request, one active row per project and hash.
-- Kept on purpose, though no production path writes them: media validations hang off attempts in many states, where
-- production validates only an OUTPUT_VERIFIED attempt, and one recovery attempt is admitted by two resolutions of
-- attempts on other requests, where production admits one for a failed PRIMARY on its own request. Covering every
-- validation status, invalid reason and resolution with consistent rows would take about twelve more attempts.
-- The job and its current deliverable version, and the scene and its current delivered request, reference each other,
-- so each pair is inserted by one statement.

-- Every type and status; one name in three organizations and in two cases; '' where a later rule could refuse it.
INSERT INTO properties (id, "organizationId", name, "propertyType", "addressMasked", description, status, "createdBy",
  "createdAt", "updatedAt", "groupId", "responsibleUserId") VALUES
  ('prp_seed35_a1', 'org_seed35_a', 'Seed House', 'HOUSE', 'Seed-ku ***', 'Fake.', 'ACTIVE', 'usr_seed35_owner',
   '2026-01-01', '2026-01-01', 'grp_seed35_a1', 'usr_seed35_manager'),
  ('prp_seed35_a2', 'org_seed35_a', 'seed house', 'APARTMENT', NULL, NULL, 'ARCHIVED', 'usr_seed35_creator',
   '2026-01-01', '2026-01-02', NULL, NULL),
  ('prp_seed35_a3', 'org_seed35_a', 'Seed Office', 'OFFICE', '', '', 'DELETED', 'usr_seed35_creator', '2026-01-01',
   '2026-01-03', 'grp_seed35_a2', 'usr_seed35_creator'),
  ('prp_seed35_b1', 'org_seed35_b', 'Seed House', 'RETAIL', NULL, NULL, 'ACTIVE', 'usr_seed35_owner', '2026-01-01',
   '2026-01-01', 'grp_seed35_b1', 'usr_seed35_owner'),
  ('prp_seed35_c1', 'org_seed35_c', 'Seed House', 'OTHER', NULL, NULL, 'ACTIVE', 'usr_seed35_viewer', '2026-01-01',
   '2026-01-01', NULL, 'usr_seed35_viewer');

-- Every status; one SHA-256 and perceptual hash twice in one organization and once in another; the integer bounds.
INSERT INTO media_assets (id, "organizationId", "propertyId", "storageKey", "originalFilename", "mimeType",
  "sizeBytes", width, height, sha256, "perceptualHash", status, "failureReason", "thumbnailKey", "createdBy",
  "deletionRequestedAt", "retentionExpiresAt", "createdAt", "updatedAt") VALUES
  ('ast_seed35_01', 'org_seed35_a', 'prp_seed35_a1', 'seed35/a/01.jpg', 'seed35.jpg', 'image/jpeg', 2147483647, 1, 1,
   lpad('51', 64, '5eed35'), '5eed355eed355e51', 'READY', NULL, 'seed35/a/01.webp', 'usr_seed35_creator', NULL, NULL,
   '2026-01-01', '2026-01-01'),
  ('ast_seed35_02', 'org_seed35_a', 'prp_seed35_a1', 'seed35/a/02.jpg', 'seed35.jpg', 'image/png', 1, 2147483647,
   2147483647, lpad('51', 64, '5eed35'), '5eed355eed355e51', 'READY', NULL, 'seed35/a/02.webp', 'usr_seed35_owner',
   NULL, NULL, '2026-01-01', '2026-01-01'),
  ('ast_seed35_03', 'org_seed35_a', 'prp_seed35_a1', 'seed35/a/03.jpg', 'seed35.jpg', NULL, NULL, NULL, NULL, NULL,
   NULL, 'PENDING_UPLOAD', NULL, NULL, 'usr_seed35_creator', NULL, NULL, '2026-01-01', '2026-01-01'),
  ('ast_seed35_b1', 'org_seed35_b', 'prp_seed35_b1', 'seed35/b/01.jpg', 'seed35.jpg', 'image/jpeg', 10, 2, 2,
   lpad('51', 64, '5eed35'), '5eed355eed355e51', 'READY', NULL, 'seed35/b/01.webp', 'usr_seed35_owner', NULL, NULL,
   '2026-01-01', '2026-01-01');

-- The other statuses, a reason on the refused ones, the deletion times on the deleted ones.
INSERT INTO media_assets (id, "organizationId", "propertyId", "storageKey", "originalFilename", "mimeType",
  "sizeBytes", width, height, sha256, status, "failureReason", "thumbnailKey", "createdBy", "deletionRequestedAt",
  "retentionExpiresAt", "createdAt", "updatedAt")
  SELECT 'ast_seed35_' || m.n, 'org_seed35_a', m.property, 'seed35/a/' || m.n || '.jpg', 'seed35.jpg', 'image/jpeg',
    10, 2, 2, lpad(m.n, 64, '5eed35'), m.status::"MediaAssetStatus", m.reason,
    CASE WHEN m.n = '10' THEN 'seed35/a/10.webp' END, 'usr_seed35_creator', m.deleted, m.retained, '2026-01-01',
    coalesce(m.deleted, '2026-01-01')
  FROM (VALUES ('04', 'prp_seed35_a2', 'UPLOADED', NULL, NULL::timestamp, NULL::timestamp),
    ('05', 'prp_seed35_a2', 'SCANNING', NULL, NULL, NULL),
    ('06', 'prp_seed35_a2', 'QUARANTINED', 'seed35 quarantined', NULL, NULL),
    ('07', 'prp_seed35_a3', 'PROCESSING', NULL, NULL, NULL),
    ('08', 'prp_seed35_a3', 'REJECTED', 'seed35 rejected', NULL, NULL),
    ('09', 'prp_seed35_a3', 'FAILED', 'seed35 failed', NULL, NULL),
    ('10', 'prp_seed35_a3', 'DELETION_PENDING', NULL, '2026-01-02', '2026-02-01'),
    ('11', 'prp_seed35_a3', 'DELETED', NULL, '2026-01-02', '2026-01-02'))
    AS m (n, property, status, reason, deleted, retained);

-- Fifteen READY photos, r01 to r15, one per room type below.
INSERT INTO media_assets (id, "organizationId", "propertyId", "storageKey", "originalFilename", status, "createdBy",
  "createdAt", "updatedAt")
  SELECT 'ast_seed35_r' || lpad(n::text, 2, '0'), 'org_seed35_a', 'prp_seed35_a1', 'seed35/a/r' || n || '.jpg',
    'seed35.jpg', 'READY', 'usr_seed35_creator', '2026-01-01', '2026-01-01'
  FROM generate_series(1, 15) AS n;

-- Every status and review status; one duplicate group in three analyses and two organizations.
INSERT INTO asset_analyses (id, "organizationId", "assetId", provider, status, "roomType", confidence,
  "qualityScore", "brightnessScore", "blurScore", "duplicateGroup", "detectedObjects", "safetyFlags",
  "suggestedOrder", "failureReason", "reviewedBy", "reviewedAt", "createdAt", "updatedAt", "analysisRevision",
  "reviewNote", "reviewStatus", "roomTypeOverride", "orderOverride", "correctedBy", "correctedAt") VALUES
  ('ana_seed35_01', 'org_seed35_a', 'ast_seed35_01', 'seed35-analyzer', 'SUCCEEDED', NULL, 1, 0, 0.5, 1,
   'seed35-dup', '["seed35"]', '["seed35"]', 0, NULL, 'usr_seed35_manager', '2026-01-02', '2026-01-01',
   '2026-01-02', 2147483647, 'seed35 note', 'APPROVED', NULL, 0, 'usr_seed35_manager', '2026-01-02'),
  ('ana_seed35_02', 'org_seed35_a', 'ast_seed35_02', 'seed35-analyzer', 'SUCCEEDED', NULL, 0, 1, 1, 0,
   'seed35-dup', '[]', '[]', 2147483647, NULL, 'usr_seed35_owner', '2026-01-02', '2026-01-01', '2026-01-02', 1, '',
   'REJECTED', NULL, 2147483647, NULL, NULL),
  ('ana_seed35_04', 'org_seed35_a', 'ast_seed35_04', 'seed35-analyzer', 'PENDING', NULL, NULL, NULL, NULL, NULL,
   NULL, '[]', '[]', NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01', 1, NULL, 'UNREVIEWED', NULL, NULL, NULL,
   NULL),
  ('ana_seed35_b1', 'org_seed35_b', 'ast_seed35_b1', 'seed35-analyzer', 'FAILED', NULL, NULL, NULL, NULL, NULL,
   'seed35-dup', '[]', '[]', NULL, 'seed35 failed', NULL, NULL, '2026-01-01', '2026-01-01', 1, NULL, 'UNREVIEWED',
   NULL, NULL, NULL, NULL);

-- Every room type, and every one as an override, in reverse.
INSERT INTO asset_analyses (id, "organizationId", "assetId", provider, status, "roomType", "updatedAt",
  "roomTypeOverride", "createdAt")
  SELECT 'ana_seed35_r' || lpad(n::text, 2, '0'), 'org_seed35_a', 'ast_seed35_r' || lpad(n::text, 2, '0'),
    'seed35-analyzer', 'SUCCEEDED', (enum_range(NULL::"RoomType"))[n], '2026-01-01',
    (enum_range(NULL::"RoomType"))[16 - n], '2026-01-01'
  FROM generate_series(1, 15) AS n;

-- Every status and both resolutions; one name in two organizations and in two cases.
INSERT INTO video_projects (id, "organizationId", "propertyId", name, status, "durationSeconds", "aspectRatio",
  resolution, "stylePreset", "cameraMotion", prompt, "negativePrompt", "includeMusic", "includeCaptions",
  "brandTemplateId", "compositionFingerprint", "createdBy", "createdAt", "updatedAt") VALUES
  ('vp_seed35_a1', 'org_seed35_a', 'prp_seed35_a1', 'Seed Tour', 'STORYBOARD_READY', 30, '16:9', '720p',
   'seed35-style', 'seed35-pan', 'seed35 prompt', 'seed35 negative', true, true, 'seed35-brand',
   'seed35-fingerprint', 'usr_seed35_owner', '2026-01-01', '2026-01-01'),
  ('vp_seed35_a2', 'org_seed35_a', 'prp_seed35_a1', 'seed tour', 'DRAFT', 90, '9:16', '1080p', NULL, NULL, NULL,
   NULL, false, false, NULL, NULL, 'usr_seed35_creator', '2026-01-01', '2026-01-01'),
  ('vp_seed35_a3', 'org_seed35_a', 'prp_seed35_a3', 'Seed Tour', 'STORYBOARD_STALE', 1, '1:1', '720p', '', '', '',
   '', false, true, '', 'seed35-fingerprint', 'usr_seed35_creator', '2026-01-01', '2026-01-01'),
  ('vp_seed35_b1', 'org_seed35_b', 'prp_seed35_b1', 'Seed Tour', 'STORYBOARD_READY', 60, '16:9', '1080p', NULL,
   NULL, NULL, NULL, true, false, NULL, 'seed35-fingerprint', 'usr_seed35_owner', '2026-01-01', '2026-01-01');

-- Position 0 in three projects with no room type, one photo in two projects' storyboards, then one scene per room
-- type.
INSERT INTO storyboard_scenes (id, "videoProjectId", "propertyId", "assetId", position, "roomType",
  "durationSeconds", "cameraMotion", "compiledPrompt", "sourceAnalysisRevision", "createdAt", "updatedAt") VALUES
  ('sbs_seed35_00', 'vp_seed35_a1', 'prp_seed35_a1', 'ast_seed35_01', 0, NULL, 1, NULL, NULL, 2147483647,
   '2026-01-01', '2026-01-01'),
  ('sbs_seed35_a2', 'vp_seed35_a2', 'prp_seed35_a1', 'ast_seed35_01', 0, NULL, 5, 'seed35-pan', 'seed35 prompt', 1,
   '2026-01-01', '2026-01-01'),
  ('sbs_seed35_b1', 'vp_seed35_b1', 'prp_seed35_b1', 'ast_seed35_b1', 0, NULL, 10, 'seed35-pan', 'seed35 prompt', 1,
   '2026-01-01', '2026-01-01');
INSERT INTO storyboard_scenes (id, "videoProjectId", "propertyId", "assetId", position, "roomType",
  "durationSeconds", "cameraMotion", "compiledPrompt", "sourceAnalysisRevision", "createdAt", "updatedAt")
  SELECT 'sbs_seed35_' || lpad(n::text, 2, '0'), 'vp_seed35_a1', 'prp_seed35_a1',
    'ast_seed35_r' || lpad(n::text, 2, '0'), n, (enum_range(NULL::"RoomType"))[n], 2, 'seed35-pan', 'seed35 prompt',
    1, '2026-01-01', '2026-01-01'
  FROM generate_series(1, 15) AS n;

-- Job 09 and its fourteen deliverable versions, the first current; versions 1 and 2 share an input fingerprint.
WITH job AS (
  INSERT INTO generation_jobs (id, "videoProjectId", "requestedByUserId", "qualityTier", "targetOutputResolution",
    "targetAspectRatio", "requestedDurationSeconds", "requiredVideoUnits", "requiredHighQualityUnits", state,
    "stateVersion", "currentDeliverableVersionId", "createdAt", "updatedAt", "disclosureMode", "idempotencyKey")
    VALUES ('gj_seed35_09', 'vp_seed35_a1', 'usr_seed35_creator', 'HIGH_QUALITY', '1080p', '16:9', 30, 1, 1,
      'DELIVERABLE_READY', 2147483647, 'gdv_seed35_01', '2026-01-01', '2026-01-02', 'THROUGHOUT', NULL)
)
INSERT INTO generation_deliverable_versions (id, "generationJobId", ordinal, "inputFingerprint", "createdAt",
  "disclosureMode")
  SELECT 'gdv_seed35_' || lpad(n::text, 2, '0'), 'gj_seed35_09', n, 'seed35-input-' || (n + 1) / 2, '2026-01-01',
    'THROUGHOUT'
  FROM generate_series(1, 14) AS n;

-- Every other state; durations at 1, 30, 31, 60, 61 and 90; one idempotency key in three projects, its 1- and
-- 200-character bounds, and NULL in one project more than once.
INSERT INTO generation_jobs (id, "videoProjectId", "requestedByUserId", "qualityTier", "targetOutputResolution",
  "targetAspectRatio", "requestedDurationSeconds", "requiredVideoUnits", "requiredHighQualityUnits", state,
  "stateVersion", "currentDeliverableVersionId", "createdAt", "updatedAt", "disclosureMode", "idempotencyKey") VALUES
  ('gj_seed35_01', 'vp_seed35_a1', 'usr_seed35_creator', 'NORMAL', '720p', '16:9', 1, 1, 0, 'CREATED', 0, NULL,
   '2026-01-01', '2026-01-01', 'THROUGHOUT', 'k'),
  ('gj_seed35_02', 'vp_seed35_a2', 'usr_seed35_creator', 'NORMAL', '1080p', '9:16', 30, 1, 0, 'RESERVING', 1, NULL,
   '2026-01-01', '2026-01-01', 'THROUGHOUT', 'k'),
  ('gj_seed35_03', 'vp_seed35_a1', 'usr_seed35_manager', 'HIGH_QUALITY', '1080p', '16:9', 31, 2, 2, 'RESERVED', 2,
   NULL, '2026-01-01', '2026-01-01', 'THROUGHOUT', repeat('k', 200)),
  ('gj_seed35_04', 'vp_seed35_a1', 'usr_seed35_creator', 'NORMAL', '720p', '16:9', 60, 2, 0, 'GENERATING', 3, NULL,
   '2026-01-01', '2026-01-01', 'THROUGHOUT', NULL),
  ('gj_seed35_05', 'vp_seed35_a1', 'usr_seed35_creator', 'HIGH_QUALITY', '1080p', '16:9', 61, 3, 3, 'SCENES_READY',
   4, NULL, '2026-01-01', '2026-01-01', 'THROUGHOUT', NULL),
  ('gj_seed35_06', 'vp_seed35_a1', 'usr_seed35_creator', 'NORMAL', '720p', '16:9', 90, 3, 0, 'COMPOSITION_PENDING',
   5, NULL, '2026-01-01', '2026-01-01', 'THROUGHOUT', NULL),
  ('gj_seed35_07', 'vp_seed35_a1', 'usr_seed35_creator', 'NORMAL', '720p', '16:9', 10, 1, 0, 'COMPOSING', 6, NULL,
   '2026-01-01', '2026-01-01', 'THROUGHOUT', NULL),
  ('gj_seed35_08', 'vp_seed35_a1', 'usr_seed35_creator', 'NORMAL', '720p', '16:9', 10, 1, 0,
   'DELIVERABLE_VALIDATING', 7, NULL, '2026-01-01', '2026-01-01', 'THROUGHOUT', NULL),
  ('gj_seed35_10', 'vp_seed35_a1', 'usr_seed35_creator', 'NORMAL', '720p', '16:9', 10, 1, 0, 'REVISING', 8, NULL,
   '2026-01-01', '2026-01-01', 'THROUGHOUT', NULL),
  ('gj_seed35_11', 'vp_seed35_a1', 'usr_seed35_creator', 'NORMAL', '720p', '16:9', 10, 1, 0, 'FAILED_TERMINAL', 9,
   NULL, '2026-01-01', '2026-01-01', 'THROUGHOUT', NULL),
  ('gj_seed35_12', 'vp_seed35_b1', 'usr_seed35_owner', 'NORMAL', '1080p', '16:9', 10, 1, 0, 'CANCELLED', 10, NULL,
   '2026-01-01', '2026-01-01', 'THROUGHOUT', 'k');

-- Job 10's one version shares job 09's first fingerprint and ordinal.
INSERT INTO generation_deliverable_versions (id, "generationJobId", ordinal, "inputFingerprint", "createdAt",
  "disclosureMode") VALUES ('gdv_seed35_15', 'gj_seed35_10', 1, 'seed35-input-1', '2026-01-01', 'THROUGHOUT');

-- Every state and funding, each state in step with its job's; 0 units, high-quality units equal to the total, and a
-- 1 ms billing window.
INSERT INTO generation_reservations (id, "generationJobId", "billingCycleKey", "billingCycleStartedAt",
  "billingCycleEndsAt", "reservedTotalVideoUnits", "reservedHighQualityUnits", state, "stateVersion", "reservedAt",
  "consumedAt", "releasedAt", "createdAt", "updatedAt", "entitlementPeriodId", funding) VALUES
  ('res_seed35_02', 'gj_seed35_02', 'seed35-2026-01', '2026-01-01', '2026-02-01', 0, 0, 'RESERVING', 0, '2026-01-01',
   NULL, NULL, '2026-01-01', '2026-01-01', NULL, 'UNALLOCATED_LEGACY'),
  ('res_seed35_03', 'gj_seed35_03', 'x', '2026-02-01', '2026-03-01', 2, 2, 'RESERVED', 1, '2026-02-02', NULL, NULL,
   '2026-02-02', '2026-02-02', 'per_seed35_a2', 'ALLOCATED'),
  ('res_seed35_04', 'gj_seed35_04', 'x', '2026-02-01', '2026-02-01 00:00:00.001', 2, 0, 'RECONCILIATION_HOLD',
   2147483647, '2026-02-02', NULL, NULL, '2026-02-02', '2026-02-02', 'per_seed35_a2', 'ALLOCATED'),
  ('res_seed35_05', 'gj_seed35_05', 'seed35-2026-01', '2026-01-01', '2026-02-01', 3, 3, 'RESERVED', 1, '2026-01-01',
   NULL, NULL, '2026-01-01', '2026-01-01', NULL, 'UNALLOCATED_LEGACY'),
  ('res_seed35_06', 'gj_seed35_06', 'x', '2026-02-01', '2026-03-01', 3, 0, 'RESERVED', 1, '2026-02-02', NULL, NULL,
   '2026-02-02', '2026-02-02', 'per_seed35_a2', 'ALLOCATED'),
  ('res_seed35_09', 'gj_seed35_09', 'x', '2026-02-01', '2026-03-01', 1, 1, 'CONSUMED', 2, '2026-02-02', '2026-02-03',
   NULL, '2026-02-02', '2026-02-03', 'per_seed35_a2', 'ALLOCATED'),
  ('res_seed35_11', 'gj_seed35_11', 'seed35-2026-01', '2026-01-01', '2026-02-01', 1, 0, 'RELEASED', 2, '2026-01-01',
   NULL, '2026-01-02', '2026-01-01', '2026-01-02', NULL, 'UNALLOCATED_LEGACY'),
  ('res_seed35_12', 'gj_seed35_12', 'seed35-2026-01', '2026-01-01', '2026-02-01', 1, 0, 'RELEASED', 2, '2026-01-02',
   NULL, '2026-01-03', '2026-01-02', '2026-01-03', 'per_seed35_b1', 'ALLOCATED');

-- Both sources and qualities; one add-on block drawn by two reservations; the ordinal and quantity bounds.
INSERT INTO generation_reservation_allocations (id, "reservationId", "organizationId", "entitlementPeriodId",
  ordinal, "sourceType", "addOnBlockId", quality, quantity, "createdAt") VALUES
  ('alc_seed35_03a', 'res_seed35_03', 'org_seed35_a', 'per_seed35_a2', 1, 'BASE', NULL, 'HIGH_QUALITY', 1,
   '2026-02-02'),
  ('alc_seed35_03b', 'res_seed35_03', 'org_seed35_a', 'per_seed35_a2', 2, 'ADD_ON_BLOCK', 'blk_seed35_a2',
   'HIGH_QUALITY', 1, '2026-02-02'),
  ('alc_seed35_04a', 'res_seed35_04', 'org_seed35_a', 'per_seed35_a2', 1, 'BASE', NULL, 'NORMAL', 1, '2026-02-02'),
  ('alc_seed35_04b', 'res_seed35_04', 'org_seed35_a', 'per_seed35_a2', 2, 'ADD_ON_BLOCK', 'blk_seed35_a1', 'NORMAL',
   1, '2026-02-02'),
  ('alc_seed35_06a', 'res_seed35_06', 'org_seed35_a', 'per_seed35_a2', 1, 'ADD_ON_BLOCK', 'blk_seed35_a1', 'NORMAL',
   3, '2026-02-02'),
  ('alc_seed35_09a', 'res_seed35_09', 'org_seed35_a', 'per_seed35_a2', 1, 'BASE', NULL, 'HIGH_QUALITY', 1,
   '2026-02-02'),
  ('alc_seed35_12a', 'res_seed35_12', 'org_seed35_b', 'per_seed35_b1', 2147483647, 'ADD_ON_BLOCK', 'blk_seed35_b1',
   'NORMAL', 2147483647, '2026-01-02');

-- Scene 01 and its requests, the INITIAL one delivered and current: two regenerations share ordinal 1, one delivered
-- and one failed, and two share ordinal 2, one pending and one cancelled.
WITH scene AS (
  INSERT INTO generation_scenes (id, "generationJobId", position, "sourceStoryboardSceneId", "sourceAssetId",
    "sourceAnalysisRevision", "snapshotDurationSeconds", "snapshotCameraMotion", "snapshotCompiledPrompt", state,
    "stateVersion", "currentDeliveredRequestId", "createdAt", "updatedAt")
    VALUES ('gs_seed35_01', 'gj_seed35_09', 0, 'sbs_seed35_00', 'ast_seed35_01', 1, 1, 'seed35-pan', 'seed35 prompt',
      'READY', 3, 'sgr_seed35_01', '2026-01-01', '2026-01-02')
)
INSERT INTO scene_generation_requests (id, "generationSceneId", kind, "userRegenerationOrdinal", state,
  "stateVersion", "requestedByUserId", "createdAt", "deliveredAt", "failedAt") VALUES
  ('sgr_seed35_01', 'gs_seed35_01', 'INITIAL', NULL, 'DELIVERED', 2, NULL, '2026-01-01', '2026-01-02', NULL),
  ('sgr_seed35_02', 'gs_seed35_01', 'USER_REGENERATION', 1, 'DELIVERED', 2, 'usr_seed35_creator', '2026-01-02',
   '2026-01-03', NULL),
  ('sgr_seed35_03', 'gs_seed35_01', 'USER_REGENERATION', 1, 'FAILED_TERMINAL', 2147483647, 'usr_seed35_creator',
   '2026-01-02', NULL, '2026-01-03'),
  ('sgr_seed35_04', 'gs_seed35_01', 'USER_REGENERATION', 2, 'PENDING', 0, 'usr_seed35_manager', '2026-01-03', NULL,
   NULL),
  ('sgr_seed35_05', 'gs_seed35_01', 'USER_REGENERATION', 2, 'CANCELLED', 1, 'usr_seed35_manager', '2026-01-03', NULL,
   NULL);

-- Every other state; position 0 in three jobs and the integer bounds.
INSERT INTO generation_scenes (id, "generationJobId", position, "sourceStoryboardSceneId", "sourceAssetId",
  "sourceAnalysisRevision", "snapshotDurationSeconds", "snapshotCameraMotion", "snapshotCompiledPrompt", state,
  "stateVersion", "currentDeliveredRequestId", "createdAt", "updatedAt") VALUES
  ('gs_seed35_02', 'gj_seed35_09', 2147483647, 'sbs_seed35_01', 'ast_seed35_r01', 2147483647, 2147483647, NULL, NULL,
   'REVISING', 0, NULL, '2026-01-01', '2026-01-01'),
  ('gs_seed35_03', 'gj_seed35_04', 0, 'sbs_seed35_00', 'ast_seed35_01', 1, 5, 'seed35-pan', 'seed35 prompt',
   'GENERATING', 1, NULL, '2026-01-01', '2026-01-01'),
  ('gs_seed35_04', 'gj_seed35_04', 1, 'sbs_seed35_01', 'ast_seed35_r01', 1, 5, NULL, NULL, 'PENDING', 0, NULL,
   '2026-01-01', '2026-01-01'),
  ('gs_seed35_05', 'gj_seed35_11', 0, 'sbs_seed35_00', 'ast_seed35_01', 1, 5, NULL, NULL, 'FAILED_TERMINAL', 1, NULL,
   '2026-01-01', '2026-01-01'),
  ('gs_seed35_06', 'gj_seed35_12', 0, 'sbs_seed35_b1', 'ast_seed35_b1', 1, 5, NULL, NULL, 'CANCELLED', 1, NULL,
   '2026-01-01', '2026-01-01');

INSERT INTO scene_generation_requests (id, "generationSceneId", kind, "userRegenerationOrdinal", state,
  "stateVersion", "requestedByUserId", "createdAt", "deliveredAt", "failedAt") VALUES
  ('sgr_seed35_06', 'gs_seed35_02', 'INITIAL', NULL, 'DELIVERED', 2, NULL, '2026-01-01', '2026-01-02', NULL),
  ('sgr_seed35_07', 'gs_seed35_02', 'USER_REGENERATION', 1, 'GENERATING', 1, 'usr_seed35_creator', '2026-01-02',
   NULL, NULL),
  ('sgr_seed35_08', 'gs_seed35_03', 'INITIAL', NULL, 'GENERATING', 1, NULL, '2026-01-01', NULL, NULL),
  ('sgr_seed35_09', 'gs_seed35_05', 'INITIAL', NULL, 'FAILED_TERMINAL', 2, NULL, '2026-01-01', NULL, '2026-01-02'),
  ('sgr_seed35_10', 'gs_seed35_06', 'INITIAL', NULL, 'CANCELLED', 1, 'usr_seed35_owner', '2026-01-01', NULL, NULL);

-- Orchestrated attempts, sg_seed35_01 to 13: every attempt state, kind and submission certainty, each column the
-- CHECKs make conditional derived from them; every resolution normalization. The inactive ones share sg_03's hash.
-- Each takes its request's storyboard scene, photo and analysis revision.
INSERT INTO scene_generations (id, "videoProjectId", "sourceStoryboardSceneId", "assetId", "sourceAnalysisRevision",
  "requestHash", "providerName", "providerModelId", state, "providerPredictionId", "submittedAt", "lastPolledAt",
  "normalizedErrorCode", "normalizedErrorMessage", "outputStorageKey", "createdAt", "updatedAt",
  "requestCompiledPrompt", "requestDurationSeconds", "requestCameraMotion", "requestAspectRatio",
  "requestRenderedPrompt", "requestModelKey", "requestTargetOutputResolution", "requestNativeGenerationResolution",
  "requestResolutionNormalization", "requestNativeMeetsTarget", "attemptKind", "attemptOrdinal",
  "generationSceneRequestId", "orchestrationState", "pricingContractKey", "providerAcceptedAt",
  "reconciliationDeadlineAt", "reconciliationResolvedAt", "reconciliationStartedAt", "stateVersion",
  "submissionBoundaryEnteredAt", "submissionCertainty", "outputSha256", "outputSizeBytes", "outputVerifiedAt")
  SELECT 'sg_seed35_' || a.n, a.project,
    CASE WHEN a.project = 'vp_seed35_b1' THEN 'sbs_seed35_b1' WHEN a.request IN ('sgr_seed35_06', 'sgr_seed35_07')
      THEN 'sbs_seed35_01' ELSE 'sbs_seed35_00' END,
    CASE WHEN a.project = 'vp_seed35_b1' THEN 'ast_seed35_b1' WHEN a.request IN ('sgr_seed35_06', 'sgr_seed35_07')
      THEN 'ast_seed35_r01' ELSE 'ast_seed35_01' END,
    CASE WHEN a.request IN ('sgr_seed35_06', 'sgr_seed35_07') THEN 2147483647 ELSE 1 END,
    'sha256:v2:' || lpad(a.hash, 64, '5eed35'),
    'seed35-provider', 'seed35-model', a.state::"SceneGenerationState",
    CASE WHEN a.certainty = 'ACCEPTED' THEN 'seed35-prediction-' || a.n END,
    CASE WHEN a.certainty = 'ACCEPTED' THEN timestamp '2026-01-01 00:01' END,
    CASE WHEN a.orch IN ('PROCESSING', 'RECONCILIATION_PENDING') THEN timestamp '2026-01-01 00:02' END,
    CASE WHEN a.orch IN ('FAILED_RETRYABLE', 'FAILED_TERMINAL', 'RECONCILIATION_EXHAUSTED') THEN 'SEED35_ERROR' END,
    CASE WHEN a.orch IN ('FAILED_RETRYABLE', 'FAILED_TERMINAL', 'RECONCILIATION_EXHAUSTED') THEN 'seed35 error' END,
    CASE WHEN a.size IS NOT NULL THEN 'seed35/a/scenes/' || a.n || '.mp4' END, '2026-01-01', '2026-01-01',
    'seed35 prompt', 5, 'seed35-pan', '16:9', 'seed35 rendered', 'seed35-model-key',
    CASE a.norm WHEN 'DOWNSCALE' THEN '720p' ELSE '1080p' END, '1080p', a.norm, a.norm <> 'UPSCALE',
    a.kind::"GenerationAttemptKind", a.ordinal, a.request, a.orch::"GenerationAttemptState", 'seed35-contract-key',
    CASE WHEN a.certainty = 'ACCEPTED' THEN timestamp '2026-01-01 00:01' END,
    CASE WHEN a.orch LIKE 'RECONCILIATION_%' THEN timestamp '2026-01-02' END,
    CASE WHEN a.orch = 'RECONCILIATION_EXHAUSTED' THEN timestamp '2026-01-02' END,
    CASE WHEN a.orch LIKE 'RECONCILIATION_%' THEN timestamp '2026-01-01 00:03' END, a.ordinal,
    CASE WHEN a.orch NOT IN ('QUEUED', 'CANCELLED_PRE_SUBMISSION') THEN timestamp '2026-01-01 00:01' END,
    a.certainty::"SubmissionCertainty", CASE WHEN a.size IS NOT NULL THEN lpad(a.n, 64, '5eed35') END, a.size,
    CASE WHEN a.size IS NOT NULL THEN timestamp '2026-01-01 00:04' END
  FROM (VALUES
    ('01', 'vp_seed35_a1', 'sgr_seed35_01', 'PRIMARY', 1, 'OUTPUT_VERIFIED', 'ACCEPTED', 'SUCCEEDED', '03', 'NONE',
     1::bigint),
    ('02', 'vp_seed35_a1', 'sgr_seed35_01', 'SYSTEM_RECOVERY', 2, 'FAILED_TERMINAL', 'DEFINITIVELY_REJECTED',
     'FAILED_TERMINAL', '03', 'DOWNSCALE', NULL),
    ('03', 'vp_seed35_a1', 'sgr_seed35_01', 'SYSTEM_RECOVERY', 3, 'QUEUED', 'PRE_SUBMISSION', 'QUEUED', '03', 'UPSCALE',
     NULL),
    ('04', 'vp_seed35_a1', 'sgr_seed35_02', 'PRIMARY', 1, 'OUTPUT_VERIFIED', 'ACCEPTED', 'SUCCEEDED', '03', 'NONE',
     9007199254740991),
    ('05', 'vp_seed35_a1', 'sgr_seed35_02', 'SYSTEM_RECOVERY', 2, 'RECONCILIATION_EXHAUSTED', 'SUBMISSION_UNKNOWN',
     'SUBMISSION_UNKNOWN', '03', 'NONE', NULL),
    ('06', 'vp_seed35_a1', 'sgr_seed35_03', 'PRIMARY', 1, 'FAILED_RETRYABLE', 'ACCEPTED', 'FAILED_RETRYABLE', '03',
     'NONE', NULL),
    ('07', 'vp_seed35_a1', 'sgr_seed35_04', 'PRIMARY', 1, 'SUBMITTING', 'PRE_SUBMISSION', 'SUBMITTING', '07', 'NONE',
     NULL),
    ('08', 'vp_seed35_a1', 'sgr_seed35_06', 'PRIMARY', 1, 'OUTPUT_VERIFIED', 'ACCEPTED', 'SUCCEEDED', '03', 'NONE',
     1048576),
    ('09', 'vp_seed35_a1', 'sgr_seed35_06', 'SYSTEM_RECOVERY', 2147483647, 'CANCELLED_PRE_SUBMISSION',
     'PRE_SUBMISSION', 'CANCELLED', '03', 'NONE', NULL),
    ('10', 'vp_seed35_a1', 'sgr_seed35_07', 'PRIMARY', 1, 'PROCESSING', 'ACCEPTED', 'PROCESSING', '10', 'NONE', NULL),
    ('11', 'vp_seed35_a1', 'sgr_seed35_08', 'PRIMARY', 1, 'RECONCILIATION_PENDING', 'SUBMISSION_UNKNOWN',
     'SUBMISSION_UNKNOWN', '11', 'NONE', NULL),
    ('12', 'vp_seed35_a1', 'sgr_seed35_09', 'PRIMARY', 1, 'PROVIDER_SUCCEEDED', 'ACCEPTED', 'SUCCEEDED', '12', 'NONE',
     NULL),
    ('13', 'vp_seed35_b1', 'sgr_seed35_10', 'PRIMARY', 1, 'OUTPUT_INGESTING', 'ACCEPTED', 'SUCCEEDED', '03', 'NONE',
     NULL)
  ) AS a (n, project, request, kind, ordinal, orch, certainty, state, hash, norm, size);

-- Unorchestrated rows, sg_seed35_l1 to l8: every scene state under pre-v2 hashes, the inactive ones sharing l1's;
-- l1 to l4 carry a request snapshot with a resolution, l5 to l8 none; a prediction with no certainty.
INSERT INTO scene_generations (id, "videoProjectId", "sourceStoryboardSceneId", "assetId", "sourceAnalysisRevision",
  "requestHash", "providerName", "providerModelId", state, "providerPredictionId", "submittedAt", "lastPolledAt",
  "normalizedErrorCode", "normalizedErrorMessage", "outputStorageKey", "createdAt", "updatedAt",
  "requestCompiledPrompt", "requestDurationSeconds", "requestCameraMotion", "requestAspectRatio", "requestResolution",
  "requestRenderedPrompt", "stateVersion", "outputSha256", "outputSizeBytes", "outputVerifiedAt")
  SELECT 'sg_seed35_l' || l.n, 'vp_seed35_a2', 'sbs_seed35_a2', 'ast_seed35_01', 1, 'sha256:' || lpad(l.hash, 64,
    '5eed35'), 'seed35-provider', 'seed35-model', l.state::"SceneGenerationState",
    CASE WHEN l.state NOT IN ('QUEUED', 'SUBMITTING') THEN 'seed35-prediction-l' || l.n END,
    CASE WHEN l.state <> 'QUEUED' THEN timestamp '2026-01-01 00:01' END,
    CASE WHEN l.state NOT IN ('QUEUED', 'SUBMITTING') THEN timestamp '2026-01-01 00:02' END,
    CASE WHEN l.state LIKE 'FAILED_%' THEN 'SEED35_ERROR' END,
    CASE WHEN l.state LIKE 'FAILED_%' THEN 'seed35 error' END,
    CASE WHEN l.state = 'SUCCEEDED' THEN 'seed35/a/scenes/l' || l.n || '.mp4' END, '2026-01-01', '2026-01-01',
    CASE WHEN l.n <= 4 THEN 'seed35 prompt' END, CASE WHEN l.n <= 4 THEN 5 END,
    CASE WHEN l.n <= 4 THEN 'seed35-pan' END, CASE WHEN l.n <= 4 THEN '16:9' END,
    CASE WHEN l.n <= 4 THEN '720p' END, CASE WHEN l.n <= 4 THEN 'seed35 rendered' END, 0,
    CASE WHEN l.state = 'SUCCEEDED' THEN lpad('4' || l.n, 64, '5eed35') END,
    CASE WHEN l.state = 'SUCCEEDED' THEN 2048 END,
    CASE WHEN l.state = 'SUCCEEDED' THEN timestamp '2026-01-01 00:04' END
  FROM (VALUES (1, 'QUEUED', '91'), (2, 'SUBMITTING', '92'), (3, 'PROCESSING', '93'), (4, 'SUCCEEDED', '91'),
    (5, 'FAILED_RETRYABLE', '95'), (6, 'FAILED_TERMINAL', '91'), (7, 'SUBMISSION_UNKNOWN', '97'),
    (8, 'CANCELLED', '91')) AS l (n, state, hash);

-- What current code writes before orchestration: a sha256:v2: hash with its five fields, no orchestration column.
INSERT INTO scene_generations (id, "videoProjectId", "sourceStoryboardSceneId", "assetId", "sourceAnalysisRevision",
  "requestHash", "providerName", "providerModelId", state, "createdAt", "updatedAt", "requestCompiledPrompt",
  "requestDurationSeconds", "requestCameraMotion", "requestAspectRatio", "requestRenderedPrompt", "requestModelKey",
  "requestTargetOutputResolution", "requestNativeGenerationResolution", "requestResolutionNormalization",
  "requestNativeMeetsTarget", "stateVersion") VALUES
  ('sg_seed35_l9', 'vp_seed35_a2', 'sbs_seed35_a2', 'ast_seed35_01', 1, 'sha256:v2:' || lpad('99', 64, '5eed35'),
   'seed35-provider', 'seed35-model', 'QUEUED', '2026-01-01', '2026-01-01', 'seed35 prompt', 5, 'seed35-pan', '9:16',
   'seed35 rendered', 'seed35-model-key', '1080p', '1080p', 'NONE', true, 0);

-- One currency pair and instant twice, at the rate bounds.
INSERT INTO fx_rate_snapshots (id, "baseCurrency", "quoteCurrency", "rateNumerator", "rateDenominator",
  "effectiveAtEpochMs", "sourceReference", "createdAt") VALUES
  ('fx_seed35_1', 'USD', 'JPY', 1, 1, 0, NULL, '2026-01-01'),
  ('fx_seed35_2', 'USD', 'JPY', 9223372036854775807, 9223372036854775807, 0, 'seed35-fx-source', '2026-01-01');

-- One contract key and fingerprint twice; zero and the integer bounds.
INSERT INTO generation_pricing_snapshots (id, "sceneGenerationId", "pricingVersion", provider, "contractKey",
  "contractFingerprint", "identityJson", "stablePriceReferenceJson", "riskProfileKey", "riskBufferBps",
  "requestedSeconds", "billableSeconds", "estimatedStableCostMicroUsd", "estimatedPlanningCostMicroUsd",
  "pricingEffectiveAtEpochMs", "fxSnapshotId", "createdAt") VALUES
  ('gps_seed35_01', 'sg_seed35_01', 'seed35-v1', 'seed35-provider', 'seed35-contract-key', lpad('61', 64, '5eed35'),
   '{"seed": 35}', '{}', 'seed35-risk', 0, 1, 1, 0, 0, 0, NULL, '2026-01-01'),
  ('gps_seed35_04', 'sg_seed35_04', 'seed35-v1', 'seed35-provider', 'seed35-contract-key', lpad('61', 64, '5eed35'),
   '{}', '{"seed": 35}', 'seed35-risk', 2147483647, 2147483647, 2147483647, 9223372036854775807,
   9223372036854775807, 9223372036854775807, 'fx_seed35_2', '2026-01-01'),
  ('gps_seed35_l4', 'sg_seed35_l4', 'seed35-v0', 'seed35-provider', 'seed35-other-key', lpad('62', 64, '5eed35'),
   '{}', '{}', 'seed35-risk', 1500, 5, 5, 100, 115, 1767225600000, 'fx_seed35_1', '2026-01-01');

-- Every status and invalid reason; NULL and a value for a PENDING row's next attempt; the receipt and fact bounds.
INSERT INTO managed_output_media_validations (id, "sceneGenerationId", status, "receiptSha256", "receiptSizeBytes",
  "leaseToken", "leaseExpiresAt", "nextAttemptAt", "attemptCount", version, "invalidReason", container,
  "durationMs", "videoWidth", "videoHeight", "videoStreamCount", "audioStreamCount", "validatedAt", "createdAt",
  "updatedAt") VALUES
  ('mov_seed35_01', 'sg_seed35_01', 'VALID', lpad('01', 64, '5eed35'), 1, NULL, NULL, NULL, 1, 2, NULL, 'ISO_BMFF',
   1, 1, 1, 1, 0, '2026-01-01', '2026-01-01', '2026-01-01'),
  ('mov_seed35_02', 'sg_seed35_04', 'VALID', lpad('04', 64, '5eed35'), 9007199254740991, NULL, NULL, NULL,
   2147483647, 2147483647, NULL, 'ISO_BMFF', 9007199254740991, 9007199254740991, 9007199254740991,
   9007199254740991, 9007199254740991, '2026-01-01', '2026-01-01', '2026-01-01'),
  ('mov_seed35_03', 'sg_seed35_08', 'VALID', lpad('08', 64, '5eed35'), 1048576, NULL, NULL, NULL, 1, 2, NULL,
   'ISO_BMFF', 5000, 1280, 720, 1, 1, '2026-01-01', '2026-01-01', '2026-01-01'),
  ('mov_seed35_04', 'sg_seed35_12', 'PENDING', lpad('12', 64, '5eed35'), 10, NULL, NULL, NULL, 0, 0, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01'),
  ('mov_seed35_05', 'sg_seed35_l6', 'PENDING', lpad('16', 64, '5eed35'), 10, NULL, NULL, '2026-01-02', 1, 1, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01'),
  ('mov_seed35_06', 'sg_seed35_13', 'RUNNING', lpad('13', 64, '5eed35'), 10, 'seed35-lease', '2026-01-01 00:05',
   NULL, 1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01'),
  ('mov_seed35_07', 'sg_seed35_02', 'INVALID_MEDIA', lpad('02', 64, '5eed35'), 10, NULL, NULL, NULL, 1, 2,
   'CONTAINER_UNSUPPORTED', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01', '2026-01-01'),
  ('mov_seed35_08', 'sg_seed35_05', 'INVALID_MEDIA', lpad('05', 64, '5eed35'), 10, NULL, NULL, NULL, 1, 2,
   'VIDEO_STREAM_MISSING', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01', '2026-01-01'),
  ('mov_seed35_09', 'sg_seed35_06', 'INVALID_MEDIA', lpad('06', 64, '5eed35'), 10, NULL, NULL, NULL, 1, 2,
   'VIDEO_DIMENSIONS_INVALID', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01', '2026-01-01'),
  ('mov_seed35_10', 'sg_seed35_09', 'INVALID_MEDIA', lpad('09', 64, '5eed35'), 10, NULL, NULL, NULL, 1, 2,
   'DURATION_INVALID', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01', '2026-01-01'),
  ('mov_seed35_11', 'sg_seed35_10', 'INVALID_MEDIA', lpad('10', 64, '5eed35'), 10, NULL, NULL, NULL, 1, 2,
   'PROBE_REJECTED', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01', '2026-01-01'),
  ('mov_seed35_12', 'sg_seed35_11', 'INVALID_MEDIA', lpad('11', 64, '5eed35'), 10, NULL, NULL, NULL, 1, 2,
   'PROBE_REJECTED', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01', '2026-01-01'),
  ('mov_seed35_13', 'sg_seed35_l4', 'INTEGRITY_MISMATCH', lpad('14', 64, '5eed35'), 10, NULL, NULL, NULL, 1, 2,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01', '2026-01-01');

-- Every status, kind and refusal code; one recovery attempt admitted by two resolutions.
INSERT INTO managed_output_media_failure_resolutions (id, "managedOutputMediaValidationId", status, "leaseToken",
  "leaseExpiresAt", "nextAttemptAt", "attemptCount", version, "lastPlanRefusalCode", "resolutionKind",
  "recoveryAttemptId", "resolvedAt", "createdAt", "updatedAt") VALUES
  ('mfr_seed35_1', 'mov_seed35_07', 'PENDING', NULL, NULL, '2026-01-02', 0, 0, NULL, NULL, NULL, NULL, '2026-01-01',
   '2026-01-01'),
  ('mfr_seed35_2', 'mov_seed35_08', 'RUNNING', 'seed35-lease', '2026-01-01 00:05', NULL, 2147483647, 2147483647,
   'PERSISTED_PRICING_IDENTITY_MALFORMED', NULL, NULL, NULL, '2026-01-01', '2026-01-01'),
  ('mfr_seed35_3', 'mov_seed35_09', 'RESOLVED', NULL, NULL, NULL, 1, 2, 'NO_SAFE_CURRENT_ROUTE', 'RECOVERY_ADMITTED',
   'sg_seed35_03', '2026-01-02', '2026-01-01', '2026-01-02'),
  ('mfr_seed35_4', 'mov_seed35_12', 'RESOLVED', NULL, NULL, NULL, 1, 2, 'NO_SAFE_CURRENT_PRICING',
   'RECOVERY_ADMITTED', 'sg_seed35_03', '2026-01-02', '2026-01-01', '2026-01-02'),
  ('mfr_seed35_5', 'mov_seed35_10', 'RESOLVED', NULL, NULL, NULL, 1, 2, 'AMBIGUOUS_CURRENT_PRICING',
   'INITIAL_FAILURE_SETTLED', NULL, '2026-01-02', '2026-01-01', '2026-01-02'),
  ('mfr_seed35_6', 'mov_seed35_11', 'RESOLVED', NULL, NULL, NULL, 1, 2, NULL, 'USER_REGENERATION_ROLLED_BACK', NULL,
   '2026-01-02', '2026-01-01', '2026-01-02'),
  ('mfr_seed35_7', 'mov_seed35_13', 'RESOLVED', NULL, NULL, NULL, 1, 2, NULL, 'OBSOLETE', NULL, '2026-01-02',
   '2026-01-01', '2026-01-02');

-- Two versions sharing an attempt and a scene; position 0 twice and its bound; the receipt bounds.
INSERT INTO generation_deliverable_inputs (id, "deliverableVersionId", position, "generationSceneId",
  "sceneGenerationRequestId", "sceneGenerationAttemptId", "mediaValidationId", "sourceSha256", "sourceSizeBytes",
  "createdAt") VALUES
  ('gdi_seed35_1', 'gdv_seed35_01', 0, 'gs_seed35_01', 'sgr_seed35_01', 'sg_seed35_01', 'mov_seed35_01',
   lpad('01', 64, '5eed35'), 1, '2026-01-02'),
  ('gdi_seed35_2', 'gdv_seed35_01', 1, 'gs_seed35_02', 'sgr_seed35_06', 'sg_seed35_08', 'mov_seed35_03',
   lpad('08', 64, '5eed35'), 1048576, '2026-01-02'),
  ('gdi_seed35_3', 'gdv_seed35_02', 0, 'gs_seed35_01', 'sgr_seed35_02', 'sg_seed35_04', 'mov_seed35_02',
   lpad('04', 64, '5eed35'), 9007199254740991, '2026-01-03'),
  ('gdi_seed35_4', 'gdv_seed35_02', 2147483647, 'gs_seed35_02', 'sgr_seed35_06', 'sg_seed35_08', 'mov_seed35_03',
   lpad('08', 64, '5eed35'), 1048576, '2026-01-03');

-- Every status, retry code and block code; the raster, counter and output bounds; one output SHA-256 twice.
INSERT INTO generation_deliverable_compositions (id, "deliverableVersionId", status, "profileKey", "targetWidthPx",
  "targetHeightPx", "frameRateNumerator", "frameRateDenominator", "videoCodec", "pixelFormat", "fitMode",
  "transitionMode", "audioMode", "encoderPreset", crf, "leaseToken", "leaseExpiresAt", "nextAttemptAt",
  "attemptCount", version, "lastRetryCode", "blockCode", "blockedAt", "outputStorageKey", "outputSha256",
  "outputSizeBytes", "outputVerifiedAt", "createdAt", "updatedAt")
  SELECT 'gdc_seed35_' || c.n, 'gdv_seed35_' || c.n, c.status::"DeliverableCompositionStatus", 'seed35-profile',
    c.w, c.h, c.fn, c.fd, 'h264', 'yuv420p', 'contain', 'cut', 'silent', 'medium', 18,
    CASE WHEN c.status = 'RUNNING' THEN 'seed35-lease' END,
    CASE WHEN c.status = 'RUNNING' THEN timestamp '2026-01-01 00:05' END,
    CASE WHEN c.status = 'PENDING' THEN timestamp '2026-01-02' END,
    CASE c.n WHEN '02' THEN 2147483647 WHEN '03' THEN 0 ELSE c.fn % 7 END,
    CASE c.n WHEN '02' THEN 2147483647 WHEN '03' THEN 0 ELSE c.fd % 7 END,
    c.retry::"DeliverableCompositionRetryCode", c.block::"DeliverableCompositionBlockCode",
    CASE WHEN c.status = 'BLOCKED' THEN timestamp '2026-01-02' END,
    CASE WHEN c.size IS NOT NULL THEN 'seed35/a/deliverables/' || c.n || '.mp4' END,
    CASE WHEN c.size IS NOT NULL THEN lpad('701', 64, '5eed35') END, c.size,
    CASE WHEN c.size IS NOT NULL THEN timestamp '2026-01-02' END, '2026-01-01', '2026-01-01'
  FROM (VALUES
    ('01', 'OUTPUT_VERIFIED', NULL, NULL, 1920, 1080, 30, 1, 1::bigint),
    ('02', 'OUTPUT_VERIFIED', NULL, NULL, 2147483646, 2147483646, 2147483647, 2147483647, 9007199254740991),
    ('03', 'PENDING', NULL, NULL, 2, 2, 30000, 1001, NULL),
    ('04', 'PENDING', 'SOURCE_READ_RETRYABLE', NULL, 1280, 720, 30, 1, NULL),
    ('05', 'PENDING', 'COMPOSER_RETRYABLE', NULL, 1280, 720, 30, 1, NULL),
    ('06', 'PENDING', 'OUTPUT_PUBLISH_RETRYABLE', NULL, 1280, 720, 30, 1, NULL),
    ('07', 'RUNNING', NULL, NULL, 1280, 720, 30, 1, NULL),
    ('08', 'BLOCKED', NULL, 'SOURCE_BYTES_LIMIT_EXCEEDED', 1280, 720, 30, 1, NULL),
    ('09', 'BLOCKED', NULL, 'DURATION_INVARIANT_MISMATCH', 1280, 720, 30, 1, NULL),
    ('10', 'BLOCKED', NULL, 'SOURCE_INTEGRITY_MISMATCH', 1280, 720, 30, 1, NULL),
    ('11', 'BLOCKED', NULL, 'OUTPUT_SIZE_LIMIT_EXCEEDED', 1280, 720, 30, 1, NULL),
    ('12', 'BLOCKED', NULL, 'CLEAN_MASTER_SIZE_LIMIT_EXCEEDED', 1280, 720, 30, 1, NULL),
    ('13', 'BLOCKED', NULL, 'CLEAN_MASTER_UNUSABLE', 1280, 720, 30, 1, NULL)
  ) AS c (n, status, retry, block, w, h, fn, fd, size);

-- Every status and invalid reason; the receipt, counter and fact bounds; one receipt SHA-256 twice, the output's.
INSERT INTO generation_deliverable_validations (id, "deliverableVersionId", status, "receiptSha256",
  "receiptSizeBytes", "leaseToken", "leaseExpiresAt", "nextAttemptAt", "attemptCount", version, "invalidReason",
  container, "durationMs", "videoWidth", "videoHeight", "videoStreamCount", "audioStreamCount", "validatedAt",
  "createdAt", "updatedAt")
  SELECT 'gdx_seed35_' || v.n, 'gdv_seed35_' || v.n, v.status::"DeliverableValidationStatus",
    lpad('7' || CASE v.n WHEN '02' THEN '01' ELSE v.n END, 64, '5eed35'), coalesce(v.fact, 10),
    CASE WHEN v.status = 'RUNNING' THEN 'seed35-lease' END,
    CASE WHEN v.status = 'RUNNING' THEN timestamp '2026-01-01 00:05' END,
    CASE WHEN v.status = 'PENDING' THEN timestamp '2026-01-02' END,
    CASE v.n WHEN '02' THEN 2147483647 WHEN '03' THEN 0 ELSE 1 END,
    CASE v.n WHEN '02' THEN 2147483647 WHEN '03' THEN 0 ELSE 2 END,
    v.reason::"ManagedOutputMediaInvalidReason",
    (CASE WHEN v.fact IS NOT NULL THEN 'ISO_BMFF' END)::"ManagedOutputContainerFamily",
    v.fact, v.fact, v.fact, v.fact, v.fact - 1,
    CASE WHEN v.status NOT IN ('PENDING', 'RUNNING') THEN timestamp '2026-01-02' END, '2026-01-01', '2026-01-01'
  FROM (VALUES ('01', 'VALID', NULL, 1::bigint), ('02', 'VALID', NULL, 9007199254740991), ('03', 'PENDING', NULL, NULL),
    ('05', 'RUNNING', NULL, NULL), ('06', 'INVALID_MEDIA', 'CONTAINER_UNSUPPORTED', NULL),
    ('07', 'INVALID_MEDIA', 'VIDEO_STREAM_MISSING', NULL), ('08', 'INVALID_MEDIA', 'VIDEO_DIMENSIONS_INVALID', NULL),
    ('09', 'INVALID_MEDIA', 'DURATION_INVALID', NULL), ('10', 'INVALID_MEDIA', 'PROBE_REJECTED', NULL),
    ('11', 'INTEGRITY_MISMATCH', NULL, NULL)) AS v (n, status, reason, fact);

-- One SHA-256 twice; the size bounds.
INSERT INTO generation_deliverable_clean_masters (id, "deliverableVersionId", "storageKey", sha256, "sizeBytes",
  "verifiedAt", "createdAt") VALUES
  ('gcm_seed35_01', 'gdv_seed35_01', 'org/org_seed35_a/internal/clean-masters/gdv_seed35_01', lpad('81', 64, '5eed35'),
   1, '2026-01-02', '2026-01-02'),
  ('gcm_seed35_02', 'gdv_seed35_02', 'org/org_seed35_a/internal/clean-masters/gdv_seed35_02', lpad('81', 64, '5eed35'),
   9007199254740991, '2026-01-03', '2026-01-03');

-- Every aggregate and actor type; one aggregate and sequence under two types; an event in a second organization.
INSERT INTO generation_transition_events (id, "organizationId", "aggregateType", "aggregateId", sequence,
  "fromState", "toState", "eventType", "actorType", "actorUserId", "reasonCode", "correlationId", "causationId",
  "safeMetadata", "createdAt") VALUES
  ('gte_seed35_1', 'org_seed35_a', 'JOB', 'gj_seed35_09', 1, NULL, 'CREATED', 'seed35.created', 'USER',
   'usr_seed35_creator', NULL, 'seed35-correlation', NULL, '{}', '2026-01-01'),
  ('gte_seed35_2', 'org_seed35_a', 'RESERVATION', 'res_seed35_09', 1, 'RESERVING', 'RESERVED', 'seed35.reserved',
   'SYSTEM', NULL, 'seed35-reason', 'seed35-correlation', 'gte_seed35_1', '{"seed": 35}', '2026-01-01'),
  ('gte_seed35_3', 'org_seed35_a', 'SCENE', 'gs_seed35_01', 1, 'PENDING', 'GENERATING', 'seed35.started', 'WORKER',
   NULL, NULL, 'seed35-correlation', 'gte_seed35_2', '{}', '2026-01-01'),
  ('gte_seed35_4', 'org_seed35_a', 'SCENE_REQUEST', 'sgr_seed35_01', 2147483647, 'GENERATING', 'DELIVERED',
   'seed35.delivered', 'ADMIN', 'usr_seed35_owner', 'seed35-reason', 'seed35-correlation', NULL, '{}', '2026-01-02'),
  ('gte_seed35_5', 'org_seed35_a', 'ATTEMPT', 'sg_seed35_05', 1, 'RECONCILIATION_PENDING', 'RECONCILIATION_EXHAUSTED',
   'seed35.exhausted', 'RECONCILIATION_WORKER', NULL, 'seed35-reason', 'seed35-correlation', NULL, '{}',
   '2026-01-02'),
  ('gte_seed35_6', 'org_seed35_a', 'DELIVERABLE', 'gdv_seed35_01', 1, NULL, 'PENDING', 'seed35.created', 'SYSTEM',
   NULL, NULL, 'seed35-correlation', NULL, '{}', '2026-01-02'),
  ('gte_seed35_7', 'org_seed35_a', 'RESERVATION', 'gj_seed35_09', 1, NULL, 'RESERVING', 'seed35.created', 'USER',
   'usr_seed35_owner', NULL, 'seed35-correlation', NULL, '{}', '2026-01-01'),
  ('gte_seed35_8', 'org_seed35_b', 'JOB', 'gj_seed35_12', 1, NULL, 'CREATED', 'seed35.created', 'USER',
   'usr_seed35_owner', NULL, 'seed35-correlation', NULL, '{}', '2026-01-01');
