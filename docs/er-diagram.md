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
    string resolution "provider-neutral"
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
- Cascade behavior: deleting an organization cascades memberships, invitations,
  and properties (and thus assets, and thus analyses); `audit_logs.organizationId`
  is `SetNull` so audit history survives.

## Deliberately not stored

- Raw passwords, raw session tokens, and raw invitation tokens — only salted
  scrypt hashes / SHA-256 hashes.
- Provider prediction ids, temporary provider URLs, and signed URLs.

## Not implemented yet (later phases)

`GenerationJob` / `ProviderGeneration` / `VideoOutput` (Phase 4–5),
`CreditLedger` / `Subscription` (Phase 6), `ConsentRecord` (Phase 6–7).
These appear in `docs/DataModel.md` but have no tables yet.
