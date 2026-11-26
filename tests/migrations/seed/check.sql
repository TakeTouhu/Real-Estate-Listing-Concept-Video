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
     'policy, subject, "windowStartedAt", count, "lockedUntil", "lockLevel", "expiresAt"'),
    ('properties', 'id', 5, 'c9eb18b3053185fb63eb72aed2f103d4',
     'id, "organizationId", name, "propertyType", "addressMasked", description, status, "createdBy", "createdAt", '
     '"updatedAt", "groupId", "responsibleUserId"'),
    ('media_assets', 'id', 27, 'ca28a373a2617179ad3d48857f9eba03',
     'id, "organizationId", "propertyId", "storageKey", "originalFilename", "mimeType", "sizeBytes", width, height, '
     'sha256, "perceptualHash", status, "failureReason", "thumbnailKey", "createdBy", "deletionRequestedAt", '
     '"retentionExpiresAt", "createdAt", "updatedAt"'),
    ('asset_analyses', 'id', 19, 'c09a2895c8b5a412ced2708a6b4c4e50',
     'id, "organizationId", "assetId", provider, status, "roomType", confidence, "qualityScore", "brightnessScore", '
     '"blurScore", "duplicateGroup", "detectedObjects", "safetyFlags", "suggestedOrder", "failureReason", '
     '"reviewedBy", "reviewedAt", "createdAt", "updatedAt", "analysisRevision", "reviewNote", "reviewStatus", '
     '"roomTypeOverride", "orderOverride", "correctedBy", "correctedAt"'),
    ('video_projects', 'id', 4, 'a84b62669bc1b6e75bd1b1eb60a8de47',
     'id, "organizationId", "propertyId", name, status, "durationSeconds", "aspectRatio", resolution, '
     '"stylePreset", "cameraMotion", prompt, "negativePrompt", "includeMusic", "includeCaptions", '
     '"brandTemplateId", "compositionFingerprint", "createdBy", "createdAt", "updatedAt"'),
    ('storyboard_scenes', 'id', 17, '879735355a9f85d35b30ffbd2c6dd1cb',
     'id, "videoProjectId", "propertyId", "assetId", "position", "roomType", "durationSeconds", "cameraMotion", '
     '"compiledPrompt", "sourceAnalysisRevision", "createdAt", "updatedAt"'),
    ('generation_jobs', 'id', 12, '7e3badead372d9a645fc615fe0c23bd3',
     'id, "videoProjectId", "requestedByUserId", "qualityTier", "targetOutputResolution", "targetAspectRatio", '
     '"requestedDurationSeconds", "requiredVideoUnits", "requiredHighQualityUnits", state, "stateVersion", '
     '"currentDeliverableVersionId", "createdAt", "updatedAt", "disclosureMode", "idempotencyKey"'),
    ('generation_deliverable_versions', 'id', 15, '0f22b843a7625004e49979a925adc3af',
     'id, "generationJobId", ordinal, "inputFingerprint", "createdAt", "disclosureMode"'),
    ('generation_reservations', 'id', 7, '0fe01b162f04fc3f09bbb6dee5b0c905',
     'id, "generationJobId", "billingCycleKey", "billingCycleStartedAt", "billingCycleEndsAt", '
     '"reservedTotalVideoUnits", "reservedHighQualityUnits", state, "stateVersion", "reservedAt", "consumedAt", '
     '"releasedAt", "createdAt", "updatedAt", "entitlementPeriodId", funding'),
    ('generation_reservation_allocations', 'id', 7, 'b3dfaeaa4730633a92499ea47898e0ee',
     'id, "reservationId", "organizationId", "entitlementPeriodId", ordinal, "sourceType", "addOnBlockId", quality, '
     'quantity, "createdAt"'),
    ('generation_scenes', 'id', 6, 'eb7d59864039da70f6c13ddab15c88f5',
     'id, "generationJobId", "position", "sourceStoryboardSceneId", "sourceAssetId", "sourceAnalysisRevision", '
     '"snapshotDurationSeconds", "snapshotCameraMotion", "snapshotCompiledPrompt", state, "stateVersion", '
     '"currentDeliveredRequestId", "createdAt", "updatedAt"'),
    ('scene_generation_requests', 'id', 10, '812056ac6bc2cab9493006a9aafb9a24',
     'id, "generationSceneId", kind, "userRegenerationOrdinal", state, "stateVersion", "requestedByUserId", '
     '"createdAt", "deliveredAt", "failedAt"'),
    ('scene_generations', 'id', 21, '26c2572c2b22b571522b97ce20e21b59',
     'id, "videoProjectId", "sourceStoryboardSceneId", "assetId", "sourceAnalysisRevision", "requestHash", '
     '"providerName", "providerModelId", state, "providerPredictionId", "submittedAt", "lastPolledAt", '
     '"normalizedErrorCode", "normalizedErrorMessage", "outputStorageKey", "createdAt", "updatedAt", '
     '"requestCompiledPrompt", "requestDurationSeconds", "requestCameraMotion", "requestAspectRatio", '
     '"requestResolution", "requestRenderedPrompt", "requestModelKey", "requestTargetOutputResolution", '
     '"requestNativeGenerationResolution", "requestResolutionNormalization", "requestNativeMeetsTarget", '
     '"attemptKind", "attemptOrdinal", "generationSceneRequestId", "orchestrationState", "pricingContractKey", '
     '"providerAcceptedAt", "reconciliationDeadlineAt", "reconciliationResolvedAt", "reconciliationStartedAt", '
     '"stateVersion", "submissionBoundaryEnteredAt", "submissionCertainty", "outputSha256", "outputSizeBytes", '
     '"outputVerifiedAt"'),
    ('fx_rate_snapshots', 'id', 2, 'c32bb68383a7f58c62ae1b0acd18bec2',
     'id, "baseCurrency", "quoteCurrency", "rateNumerator", "rateDenominator", "effectiveAtEpochMs", '
     '"sourceReference", "createdAt"'),
    ('generation_pricing_snapshots', 'id', 3, '876781c706c939eb7c430f1b094a0711',
     'id, "sceneGenerationId", "pricingVersion", provider, "contractKey", "contractFingerprint", "identityJson", '
     '"stablePriceReferenceJson", "riskProfileKey", "riskBufferBps", "requestedSeconds", "billableSeconds", '
     '"estimatedStableCostMicroUsd", "estimatedPlanningCostMicroUsd", "pricingEffectiveAtEpochMs", "fxSnapshotId", '
     '"createdAt"'),
    ('managed_output_media_validations', 'id', 13, '1d9d489f007c77bddbe091627f8fecc9',
     'id, "sceneGenerationId", status, "receiptSha256", "receiptSizeBytes", "leaseToken", "leaseExpiresAt", '
     '"nextAttemptAt", "attemptCount", version, "invalidReason", container, "durationMs", "videoWidth", '
     '"videoHeight", "videoStreamCount", "audioStreamCount", "validatedAt", "createdAt", "updatedAt"'),
    ('managed_output_media_failure_resolutions', 'id', 7, '64098b941f51fa7bea25fc8d1276bdcc',
     'id, "managedOutputMediaValidationId", status, "leaseToken", "leaseExpiresAt", "nextAttemptAt", '
     '"attemptCount", version, "lastPlanRefusalCode", "resolutionKind", "recoveryAttemptId", "resolvedAt", '
     '"createdAt", "updatedAt"'),
    ('generation_deliverable_inputs', 'id', 4, 'ae048436ecd074514f0cc5fe289a9895',
     'id, "deliverableVersionId", "position", "generationSceneId", "sceneGenerationRequestId", '
     '"sceneGenerationAttemptId", "mediaValidationId", "sourceSha256", "sourceSizeBytes", "createdAt"'),
    ('generation_deliverable_compositions', 'id', 13, '88df11faec8fb9621aa9a5d7d995c1e0',
     'id, "deliverableVersionId", status, "profileKey", "targetWidthPx", "targetHeightPx", "frameRateNumerator", '
     '"frameRateDenominator", "videoCodec", "pixelFormat", "fitMode", "transitionMode", "audioMode", '
     '"encoderPreset", crf, "leaseToken", "leaseExpiresAt", "nextAttemptAt", "attemptCount", version, '
     '"lastRetryCode", "blockCode", "blockedAt", "outputStorageKey", "outputSha256", "outputSizeBytes", '
     '"outputVerifiedAt", "createdAt", "updatedAt"'),
    ('generation_deliverable_validations', 'id', 10, 'dc1e0a796cbd98004f3fbaaccb3cdc5c',
     'id, "deliverableVersionId", status, "receiptSha256", "receiptSizeBytes", "leaseToken", "leaseExpiresAt", '
     '"nextAttemptAt", "attemptCount", version, "invalidReason", container, "durationMs", "videoWidth", '
     '"videoHeight", "videoStreamCount", "audioStreamCount", "validatedAt", "createdAt", "updatedAt"'),
    ('generation_deliverable_clean_masters', 'id', 2, '776e39502dc04091f11c6359b8dd2cca',
     'id, "deliverableVersionId", "storageKey", sha256, "sizeBytes", "verifiedAt", "createdAt"'),
    ('generation_transition_events', 'id', 7, 'dc34f649f1a0b4ea7dcfea04195dd178',
     'id, "organizationId", "aggregateType", "aggregateId", sequence, "fromState", "toState", "eventType", '
     '"actorType", "actorUserId", "reasonCode", "correlationId", "causationId", "safeMetadata", "createdAt"')
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
