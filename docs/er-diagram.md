# Entity-Relationship Diagram

Version: 1.4 (as implemented through Phase 3C-1)
Source of truth: `packages/database/prisma/schema.prisma`
Status: Describes **implemented** tables only. Entities from
`docs/DataModel.md` that belong to later phases are listed at the bottom.

## Implemented schema

```mermaid
erDiagram
  ORGANIZATIONS ||--o{ MEMBERSHIPS : has
  ORGANIZATIONS ||--o{ INVITATIONS : issues
  ORGANIZATIONS ||--o{ AUDIT_LOGS : scopes
  ORGANIZATIONS ||--o{ PROPERTIES : owns
  USERS ||--o| CREDENTIALS : "authenticates with"
  USERS ||--o{ MEMBERSHIPS : joins
  USERS ||--o{ SESSIONS : holds
  PROPERTIES ||--o{ MEDIA_ASSETS : contains
  MEDIA_ASSETS ||--o| ASSET_ANALYSES : "is analyzed by"
  PROPERTIES ||--o{ VIDEO_PROJECTS : "is filmed by"
  VIDEO_PROJECTS ||--o{ STORYBOARD_SCENES : sequences
  MEDIA_ASSETS ||--o{ STORYBOARD_SCENES : "is the source of"
  VIDEO_PROJECTS ||--o{ SCENE_GENERATIONS : "attempts (RESTRICT)"

  ORGANIZATIONS {
    string id PK
    string name
    string slug UK
    enum   status "ACTIVE|SUSPENDED"
    datetime createdAt
    datetime updatedAt
  }

  USERS {
    string id PK
    string email UK
    string name
    enum   status "ACTIVE|DISABLED"
    datetime createdAt
    datetime updatedAt
  }

  CREDENTIALS {
    string userId PK_FK
    string passwordHash "scrypt, salted"
    datetime createdAt
    datetime updatedAt
  }

  MEMBERSHIPS {
    string organizationId PK_FK
    string userId PK_FK
    enum   role "OWNER|ADMIN|CREATOR|REVIEWER"
    datetime createdAt
  }

  INVITATIONS {
    string id PK
    string organizationId FK
    string email
    enum   role
    string tokenHash UK "SHA-256 only"
    enum   status "PENDING|ACCEPTED|REVOKED|EXPIRED"
    string invitedByUserId
    datetime expiresAt
    datetime acceptedAt "nullable"
    datetime createdAt
  }

  SESSIONS {
    string id PK
    string userId FK
    string tokenHash UK "SHA-256 only"
    datetime expiresAt
    datetime createdAt
  }

  PROPERTIES {
    string id PK
    string organizationId FK "tenant scope"
    string name
    enum   propertyType "APARTMENT|HOUSE|OFFICE|RETAIL|OTHER"
    string addressMasked "nullable"
    string description "nullable"
    enum   status "ACTIVE|ARCHIVED|DELETED"
    string createdBy
    datetime createdAt
    datetime updatedAt
  }

  MEDIA_ASSETS {
    string id PK
    string organizationId FK "tenant scope"
    string propertyId FK
    string storageKey UK "org-prefixed, opaque"
    string originalFilename "sanitized"
    string mimeType "nullable, from magic bytes"
    int    sizeBytes "nullable"
    int    width "nullable"
    int    height "nullable"
    string sha256 "nullable"
    string perceptualHash "nullable, 16 hex"
    enum   status "10-state lifecycle"
    string failureReason "nullable, sanitized"
    string thumbnailKey "nullable"
    string createdBy
    datetime deletionRequestedAt "nullable"
    datetime retentionExpiresAt "nullable"
    datetime createdAt
    datetime updatedAt
  }

  ASSET_ANALYSES {
    string id PK
    string organizationId "tenant scope"
    string assetId FK_UK "one analysis per asset"
    string provider "adapter name, not a secret"
    enum   status "PENDING|SUCCEEDED|FAILED"
    enum   roomType "nullable, 15 values"
    float  confidence "nullable, 0..1"
    float  qualityScore "nullable, 0..1"
    float  brightnessScore "nullable, 0..1"
    float  blurScore "nullable, 0..1"
    string duplicateGroup "nullable, groups near-identical photos"
    json   detectedObjects "bounded list, normalized"
    json   safetyFlags "bounded list, BLOCKING|WARNING"
    int    suggestedOrder "nullable, walkthrough rank"
    string failureReason "nullable, sanitized"
    enum   roomTypeOverride "nullable, reviewer's corrected room; AI roomType preserved"
    int    orderOverride "nullable, reviewer's sort priority (not a fixed position)"
    string correctedBy "nullable, who corrected this revision"
    datetime correctedAt "nullable"
    int    analysisRevision "persisted result, increments on successful refresh"
    enum   reviewStatus "UNREVIEWED|APPROVED|REJECTED"
    string reviewNote "nullable, required for rejection"
    string reviewedBy "nullable, human approver"
    datetime reviewedAt "nullable"
    datetime createdAt
    datetime updatedAt
  }

  VIDEO_PROJECTS {
    string id PK
    string organizationId "tenant scope"
    string propertyId FK
    string name
    enum   status "DRAFT|STORYBOARD_READY|STORYBOARD_STALE"
    int    durationSeconds "requested; provider validation is Phase 4"
    string aspectRatio "provider-neutral"
    string targetOutputResolution "column `resolution`; CHECK 720p|1080p"
    string stylePreset "nullable"
    string cameraMotion "nullable"
    string prompt "nullable, untrusted user text"
    string negativePrompt "nullable, untrusted user text"
    boolean includeMusic
    boolean includeCaptions
    string brandTemplateId "nullable"
    string compositionFingerprint "nullable, digest of the APPROVED input set"
    string createdBy
    datetime createdAt
    datetime updatedAt
  }

  STORYBOARD_SCENES {
    string id PK
    string videoProjectId FK "composite with propertyId"
    string propertyId "half of both composite FKs"
    string assetId FK "composite with propertyId"
    int    position "UK with videoProjectId"
    enum   roomType "nullable, 15 values"
    int    durationSeconds
    string cameraMotion "nullable"
    string compiledPrompt "nullable until Phase 3C-3"
    int    sourceAnalysisRevision "provenance"
    datetime createdAt
    datetime updatedAt
  }

  SCENE_GENERATIONS {
    string id PK
    string videoProjectId FK "ON DELETE RESTRICT"
    string sourceStoryboardSceneId "provenance, NO FK"
    string assetId "provenance, NO FK"
    int    sourceAnalysisRevision "provenance"
    string requestHash "active-UK with videoProjectId; sha256:v2: since 4C-3B-2B"
    string providerName "internal"
    string providerModelId "internal"
    string requestResolution "nullable; V1 only, never written again"
    string requestModelKey "nullable; V2 snapshot, all-or-none"
    string requestTargetOutputResolution "nullable; CHECK 720p|1080p"
    string requestNativeGenerationResolution "nullable; provider token, opaque"
    string requestResolutionNormalization "nullable; CHECK NONE|DOWNSCALE|UPSCALE"
    boolean requestNativeMeetsTarget "nullable; false = upscaled, not native"
    enum   state "8 values, default QUEUED"
    string providerPredictionId "nullable, internal only"
    datetime submittedAt "nullable"
    datetime lastPolledAt "nullable"
    string normalizedErrorCode "nullable, internal"
    string normalizedErrorMessage "nullable, internal"
    string outputStorageKey "nullable until Phase 4D"
    datetime createdAt
    datetime updatedAt
  }

  AUDIT_LOGS {
    string id PK
    string organizationId FK "nullable"
    string actorUserId "nullable"
    string action
    string resourceType
    string resourceId
    json   metadata "sanitized"
    datetime createdAt
  }
```

## Tenant-scope and index notes

- Every tenant-owned table carries `organizationId` — **except
  `storyboard_scenes`**, which inherits tenant scope through its project (see
  below). All repository reads filter on the organization either directly or
  through that relation, so another tenant's row is simply not found.
- Composite/indexed for tenant queries:
  `properties(organizationId, status)`,
  `media_assets(organizationId, propertyId, status)`,
  `media_assets(organizationId, sha256)`,
  `asset_analyses(organizationId, status)`,
  `asset_analyses(organizationId, duplicateGroup)`,
  `asset_analyses(organizationId, reviewStatus)`,
  `audit_logs(organizationId)`, `audit_logs(createdAt)`,
  `memberships(userId)`, `invitations(organizationId, email)`,
  `sessions(userId)`.
- `media_assets.storageKey` is unique, preventing two rows from claiming the
  same object.
- `asset_analyses.assetId` is unique, so an asset can never accumulate more than
  one analysis row; a re-run updates the existing row in place.
- The four correction columns (`roomTypeOverride`, `orderOverride`,
  `correctedBy`, `correctedAt`) are **unindexed by design**: a correction is
  read as part of the analysis row already being loaded by primary key or by the
  unique `assetId`, and is never searched by. `orderOverride` carries **no**
  uniqueness or range constraint — duplicate priorities are legitimate and
  resolve deterministically during ordering, and which values are *valid* is a
  product rule owned by the correction service, not by the schema (ADR-0015).
- **Partial unique index** `asset_analyses_org_dupgroup_approved_key` on
  `(organizationId, duplicateGroup) WHERE duplicateGroup IS NOT NULL AND
  reviewStatus = 'APPROVED'`. The database is authoritative for "at most one
  approved analysis per duplicate group", so concurrent approvals of two members
  of a group cannot both succeed. Prisma cannot express a partial index, so it
  is hand-written in the migration — see `docs/migration-notes.md`.
- **`storyboard_scenes` carries no `organizationId`.** A scene is owned by its
  project, and duplicating the column would create a second source of truth that
  application code could let drift. Reads filter through the parent
  (`videoProject: { organizationId }`), and writes are constrained by two
  composite foreign keys — `(videoProjectId, propertyId) → video_projects(id,
  propertyId)` and `(assetId, propertyId) → media_assets(id, propertyId)` — so a
  scene whose project and asset belong to different properties, and therefore
  different organizations, **cannot be inserted at all**. The supporting unique
  keys `video_projects(id, propertyId)` and `media_assets(id, propertyId)` exist
  only to make those foreign keys possible.
- `storyboard_scenes(videoProjectId, position)` is unique: two scenes cannot
  claim the same position in one project. Composition therefore replaces a
  project's scenes wholesale rather than diffing them.
- **`scene_generations` carries no `organizationId` either**, for the same
  reason: it is owned by its `video_projects` row, and reads resolve the tenant
  through `videoProject: { organizationId }`.
- **Two of its id columns are deliberately not foreign keys.**
  `sourceStoryboardSceneId` points at a row `replaceForProject` deletes and
  recreates on every recomposition, and `assetId` points at a photo the
  retention pipeline may remove. A generation row can record a *paid* provider
  attempt, so a cascade from either would destroy that record during an ordinary
  user action, and a restrict would block recomposition. Both are provenance
  (ADR-0016).
- **Partial unique index** `scene_generations_active_request_key` on
  `(videoProjectId, requestHash) WHERE state IN ('QUEUED', 'SUBMITTING',
  'PROCESSING', 'FAILED_RETRYABLE', 'SUBMISSION_UNKNOWN')`. The database is
  authoritative for "at most one **active** attempt per request identity", so
  two concurrent submissions cannot both produce a billed provider call.
  Terminal states release the identity, allowing deliberate regeneration.
  Hand-written in the migration, and guarded against drift from the domain's
  `ACTIVE_SCENE_GENERATION_STATES` by
  `tests/schema/active-generation-states.test.ts`.
- Cascade behavior: deleting an organization cascades memberships, invitations,
  and properties (and thus assets, and thus analyses); `audit_logs.organizationId`
  is `SetNull` so audit history survives. **`scene_generations` is the one
  exception**: its foreign key to `video_projects` is `ON DELETE RESTRICT`, so a
  project cannot be physically deleted while an attempt exists. That is
  fail-closed on purpose — no physical deletion path exists today, and a future
  one must resolve retention policy for paid-attempt history deliberately rather
  than inheriting a cascade.

### Request-identity versioning (Phase 4C-3B-2B, ADR-0034)

Three CHECK constraints, added by raw SQL because Prisma cannot express them:

- `video_projects_resolution_target_check` — the project's product target is
  `720p` or `1080p`. Applied to the existing physical `resolution` column, which
  the Prisma model now maps as `targetOutputResolution`. **The migration fails
  closed** on any pre-existing value outside that set rather than rewriting a
  customer's stated request.
- `scene_generations_request_identity_version_check` — one request-identity
  vocabulary per row, keyed off the version the `requestHash` itself states. A
  `sha256:v2:` row carries all five V2 delivery columns and no
  `requestResolution`; any other row carries none of the five. This forbids both
  a partially populated V2 snapshot (which would look reconstructable and hash
  to something else) and a row holding both vocabularies at once.
- `scene_generations_target_output_resolution_check` and
  `scene_generations_resolution_normalization_check` — the two closed
  vocabularies, checked only when a value is present so legacy rows stay valid.
- `scene_generations_model_key_nonblank_check` and
  `scene_generations_native_resolution_nonblank_check` — both are identifiers,
  and an empty string is not one. Checked as non-blank rather than merely
  non-null because the all-or-none rule is satisfied by `''`. There is
  deliberately no syntax rule on the native token beyond that: it is the
  vendor's, and this system does not parse it.

None of the V2 columns is indexed: they are reconstruction payload, and identity
lookups still use the `(videoProjectId, requestHash)` partial unique index.

`requestResolution` is **retained and never written again**. V1 rows were hashed
over it, so it is the only surviving record of what those attempts were admitted
for; the V2 columns are never backfilled from it, because deciding which of its
two meanings applied is exactly the ambiguity ADR-0034 removes.

## Deliberately not stored

- Raw passwords, raw session tokens, and raw invitation tokens — only salted
  scrypt hashes / SHA-256 hashes.
- **Temporary provider output URLs** and signed URLs. A generation attempt never
  stores a URL that expires: Phase 4D copies a completed output into managed
  storage and persists `outputStorageKey`, so nothing later depends on a link
  going stale. A live test asserts no `scene_generations` column name contains
  `url`.
- Retry counters on `scene_generations` — no worker exists yet to have a retry
  policy, and a speculative column would be a guess at an unreviewed design.

  **Changed in Phase 4A-2a:** provider prediction ids *are* now stored, in
  `scene_generations.providerPredictionId`. They have to be — `PROCESSING`
  asserts a known prediction, and polling needs it. They remain **internal
  only**: never in a customer-facing DTO, never logged (ADR-0016 §9). This entry
  previously listed them as not stored at all.

## Not implemented yet (later phases)

`VideoOutput` (Phase 5), `CreditLedger` / `Subscription` (Phase 6),
`ConsentRecord` (Phase 6–7). These appear in `docs/DataModel.md` but have no
tables yet. The Phase 4 generation attempt is `scene_generations`, above.
