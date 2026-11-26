-- Run by upgrade.sh after the head's migrations: every seeded row is still there, with the values it was seeded with.
--
-- For each seeded table: the rows whose key column holds seed35 (or starts with 5eed35), how many, and the MD5 of
-- those rows' seeded columns as text, sorted bytewise. A later migration that adds a column changes nothing here; one
-- that drops a seeded column fails at that table. A migration that changes a seeded value on purpose updates the
-- table's digest below and names itself in "Allowed changes". The message prints the digest found, which is a hash of
-- fake rows only.
--
-- Allowed changes: none yet.

DO $check$
DECLARE
  t record;
  found_rows bigint;
  found_digest text;
  faults text := '';
BEGIN
  PERFORM set_config('DateStyle', 'ISO, YMD', true);
  PERFORM set_config('IntervalStyle', 'postgres', true);
  FOR t IN SELECT * FROM (VALUES
    ('organizations', 'id', 3, '9320bf895dc3a21f8c4a92fa929764c7',
     'id, name, slug, status, "mfaRequired", "createdAt", "updatedAt"'),
    ('users', 'id', 6, '233167f7d10e358ba6cada11a10f1c39',
     'id, email, name, status, "emailVerifiedAt", "createdAt", "updatedAt"'),
    ('credentials', 'userId', 2, '683d916f6f182a3925082173c31f2e2e',
     '"userId", "passwordHash", "createdAt", "updatedAt"'),
    ('user_mfa_factors', 'userId', 2, 'e4736268ec38b05a0975c61b73284bd8',
     '"userId", secret, "lastUsedStep", "enabledAt", "updatedAt"'),
    ('user_mfa_recovery_codes', 'userId', 3, '07307db1917686ac6dff9906dab64a39',
     '"userId", "codeHash", "createdAt"'),
    ('account_links', 'id', 3, '605df78d5fa214080bfbb367873f5c76',
     'id, "userId", purpose, "tokenHash", email, "expiresAt", "usedAt", "createdAt"'),
    ('sessions', 'id', 2, 'bda1890d713f7428c925a71d255af7cd',
     'id, "userId", "tokenHash", "expiresAt", "mfaVerifiedAt", "mfaFailedAttempts", "mfaPendingSecret", '
     '"createdAt"'),
    ('memberships', 'organizationId', 8, '690c9efae4aa98a806af0d94a1d741b1',
     '"organizationId", "userId", role, "createdAt"'),
    ('member_permission_grants', 'organizationId', 29, 'd6e55d60be79898341880fed8f827bfc',
     '"organizationId", "userId", permission, "grantedByUserId", "grantedAt"'),
    ('groups', 'id', 5, '52ff7b775045372ca927311d45dd447e',
     'id, "organizationId", name, "createdByUserId", "createdAt", "updatedAt"'),
    ('group_members', 'groupId', 4, '732e181269c51d68a9921367ea59d4b6',
     '"groupId", "organizationId", "userId", "addedByUserId", "addedAt"'),
    ('group_permissions', 'groupId', 28, 'fa0c4889a031058047a393920d6ba0c1',
     '"groupId", "organizationId", permission, "grantedByUserId", "grantedAt"'),
    ('invitations', 'id', 6, 'b0b5e97e7ad2a845ebc14e1f8e6626a6',
     'id, "organizationId", email, role, "tokenHash", status, "invitedByUserId", "expiresAt", "acceptedAt", '
     '"createdAt"'),
    ('audit_logs', 'id', 3, '5ff281ef1523933cc6b29a9a2917da27',
     'id, "organizationId", "actorUserId", action, "resourceType", "resourceId", metadata, "createdAt"'),
    ('organization_subscriptions', 'id', 3, '7a8f9e49bf2fe634b1e0509be4cb2f37',
     'id, "organizationId", "planKey", channel, "anchorAt", "commercialReference", "createdAt"'),
    ('unit_entitlement_periods', 'id', 4, '78ccaece2b80e9f6eb0c722273c8b537',
     'id, "organizationId", "billingCycleKey", "planKey", "baseUnits", "includedHighQualityUnits", '
     '"highQualityAddOnAvailable", "startsAt", "endsAt", "commercialReference", "createdAt"'),
    ('unit_add_on_blocks', 'id', 3, 'f4a8fb39f7e26cf5fc741bc183257ba7',
     'id, "organizationId", "entitlementPeriodId", quality, quantity, "commercialReference", "purchasedAt", '
     '"createdAt"'),
    ('unit_purchases', 'id', 3, '8f35f6c3a497314af2be1bd2f2bc7d87',
     'id, "organizationId", "entitlementPeriodId", "addOnBlockId", quality, "priceYenExTax", channel, '
     '"contractReference", "idempotencyKey", "approvedByUserId", "approvedAt", "createdAt"'),
    ('unit_purchase_cancellations', 'purchaseId', 2, '821b784c3b2fa22e71aad4c8bb499b8e',
     '"purchaseId", "organizationId", fault, "operatorName", reason, "cancelledAt"'),
    ('rate_limit_counters', 'subject', 4, '73bd0a3bfd0be063d95acae597619858',
     'policy, subject, "windowStartedAt", count, "lockedUntil", "lockLevel", "expiresAt"')
  ) AS seeded (tbl, key, expected_rows, expected_digest, cols)
  LOOP
    EXECUTE format(
      'SELECT count(*), md5(string_agg(r, E''\n'' ORDER BY r COLLATE "C")) FROM '
      '(SELECT ROW(%s)::text AS r FROM %I WHERE strpos(%I, ''seed35'') > 0 OR left(%I, 6) = ''5eed35'') AS s',
      t.cols, t.tbl, t.key, t.key)
      INTO found_rows, found_digest;
    IF found_rows <> t.expected_rows THEN
      faults := faults || format(E'\n%s: %s seeded row(s), expected %s', t.tbl, found_rows, t.expected_rows);
    ELSIF found_digest IS DISTINCT FROM t.expected_digest THEN
      faults := faults || format(E'\n%s: a seeded value changed (digest %s)', t.tbl, found_digest);
    END IF;
  END LOOP;
  IF faults <> '' THEN
    RAISE EXCEPTION 'The seeded rows did not survive the upgrade:%', faults;
  END IF;
  RAISE NOTICE 'Seed check: every seeded row kept its values.';
END
$check$;
